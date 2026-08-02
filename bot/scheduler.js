const cron = require('node-cron');
const { getSchedule } = require('./db/schedule');
const { getGroupedActiveCooldowns } = require('./db/promoLog');
const { getDueMessages, markSent, markFailed } = require('./db/scheduledMessages');
const { getPendingActions, markActionResult } = require('./db/groupActions');
const { TIMEZONE, CLOSE_MESSAGE, OPEN_MESSAGE } = require('./config');

let closeJob = null;
let openJob = null;
let currentGroupId = null;

async function startScheduler(getSock, groupId) {
  currentGroupId = groupId;
  await reschedule(getSock, groupId);
  // Re-check jadwal tiap 5 menit (kalau admin update via dashboard)
  setInterval(async () => {
    await reschedule(getSock, groupId);
  }, 5 * 60 * 1000);

  // Cek pesan terjadwal (pengumuman dari dashboard) tiap 1 menit
  startMessageQueueWorker(getSock, groupId);

  // Cek antrean tambah/kick anggota (dari dashboard) tiap 20 detik
  startGroupActionWorker(getSock, groupId);
}

// ─── PESAN TERJADWAL / PENGUMUMAN DARI DASHBOARD ────────────────
// PENTING: bagian ini sebelumnya TIDAK ADA sama sekali di scheduler.js,
// jadi dashboard cuma nulis baris ke tabel scheduled_messages tapi tidak
// pernah ada yang baca & kirim. Makanya pengumuman tidak pernah terkirim.
function startMessageQueueWorker(getSock, groupId) {
  checkDueMessages(getSock, groupId); // cek langsung sekali saat start
  setInterval(() => checkDueMessages(getSock, groupId), 60 * 1000);
}

async function checkDueMessages(sockOrGetSock, groupId) {
  let due;
  try {
    due = await getDueMessages(groupId);
  } catch (e) {
    console.error('Error cek pesan terjadwal:', e);
    return;
  }
  if (!due.length) return;

  const sock = await waitForSock(sockOrGetSock, { retries: 3, delayMs: 2000 });
  if (!sock) {
    console.error('❌ Batal kirim pesan terjadwal: socket tidak tersedia.');
    return;
  }

  for (const item of due) {
    try {
      await sock.sendMessage(groupId, { text: item.message });
      await markSent(item.id);
      console.log(`✅ Pesan terjadwal #${item.id} terkirim ke ${groupId}`);
    } catch (e) {
      console.error(`❌ Gagal kirim pesan terjadwal #${item.id}:`, e);
      await markFailed(item.id, e?.message || e);
    }
  }
}

// ─── TAMBAH / KICK ANGGOTA DARI DASHBOARD ───────────────────────
function startGroupActionWorker(getSock, groupId) {
  checkPendingActions(getSock, groupId);
  setInterval(() => checkPendingActions(getSock, groupId), 20 * 1000);
}

async function checkPendingActions(sockOrGetSock, groupId) {
  let pending;
  try {
    pending = await getPendingActions(groupId);
  } catch (e) {
    console.error('Error cek antrean anggota:', e);
    return;
  }
  if (!pending.length) return;

  const sock = await waitForSock(sockOrGetSock, { retries: 3, delayMs: 2000 });
  if (!sock) {
    console.error('❌ Batal proses antrean anggota: socket tidak tersedia.');
    return;
  }

  for (const item of pending) {
    if (item.action === 'add') {
      await processAddMember(sock, groupId, item);
    } else if (item.action === 'kick') {
      await processKickMember(sock, groupId, item);
    } else {
      await markActionResult(item.id, 'failed', `Aksi tidak dikenal: ${item.action}`);
    }
  }
}

function toJid(phone) {
  const digits = String(phone).replace(/[^0-9]/g, '');
  return `${digits}@s.whatsapp.net`;
}

// Terjemahkan status code hasil groupParticipantsUpdate dari WhatsApp/Baileys
// jadi pesan yang jelas buat admin. Catatan: kode-kode ini best-effort sesuai
// perilaku WhatsApp saat ini dan bisa berbeda di beberapa kasus.
function describeParticipantStatus(status, action) {
  const s = String(status);
  if (action === 'add') {
    switch (s) {
      case '200': return { ok: true, message: null };
      case '403': return { ok: false, message: 'Gagal ditambahkan otomatis (pengaturan privasi nomor ini membatasi siapa yang bisa menambahkannya ke grup). Undangan grup sudah dicoba dikirim lewat chat pribadi jika memungkinkan.' };
      case '404': return { ok: false, message: 'Nomor tidak terdaftar di WhatsApp.' };
      case '408': return { ok: false, message: 'Gagal ditambahkan — kemungkinan nomor ini baru saja keluar dari grup atau menolak undangan. Coba lagi beberapa saat lagi.' };
      case '409': return { ok: false, message: 'Nomor ini sudah menjadi anggota grup.' };
      case '500': return { ok: false, message: 'Gagal menambahkan karena masalah di sisi WhatsApp. Coba lagi nanti.' };
      default: return { ok: false, message: `Gagal menambahkan (kode: ${s || 'tidak diketahui'}).` };
    }
  } else {
    switch (s) {
      case '200': return { ok: true, message: null };
      case '401':
      case '403': return { ok: false, message: 'Bot tidak punya izin admin untuk mengeluarkan anggota ini.' };
      case '404': return { ok: false, message: 'Nomor ini bukan anggota grup (mungkin sudah keluar duluan).' };
      default: return { ok: false, message: `Gagal mengeluarkan (kode: ${s || 'tidak diketahui'}).` };
    }
  }
}

async function processAddMember(sock, groupId, item) {
  const jid = toJid(item.phone);
  try {
    // Cek dulu apakah nomor ini terdaftar di WhatsApp — kalau tidak, langsung
    // kasih pesan jelas tanpa perlu nunggu WhatsApp menolak request add.
    const check = await sock.onWhatsApp(jid);
    const exists = Array.isArray(check) && check.length > 0 && check[0]?.exists;
    if (!exists) {
      await markActionResult(item.id, 'failed', 'Nomor tidak terdaftar di WhatsApp.');
      console.log(`❌ Tambah #${item.id}: nomor tidak terdaftar di WhatsApp.`);
      return;
    }

    const result = await sock.groupParticipantsUpdate(groupId, [jid], 'add');
    const entry = Array.isArray(result) ? result[0] : null;
    const { ok, message } = describeParticipantStatus(entry?.status, 'add');

    if (ok) {
      await markActionResult(item.id, 'success');
      console.log(`✅ Tambah #${item.id}: ${item.phone} berhasil ditambahkan.`);
      return;
    }

    // Kalau gagal karena privasi (403), coba fallback kirim link undangan ke DM
    if (String(entry?.status) === '403') {
      try {
        const inviteCode = await sock.groupInviteCode(groupId);
        await sock.sendMessage(jid, {
          text: `Kamu diundang untuk bergabung ke grup ini:\nhttps://chat.whatsapp.com/${inviteCode}`,
        });
      } catch (dmErr) {
        console.warn(`⚠️ Gagal kirim undangan DM ke ${item.phone}:`, dmErr?.message || dmErr);
      }
    }

    await markActionResult(item.id, 'failed', message);
    console.log(`❌ Tambah #${item.id}: ${message}`);
  } catch (e) {
    console.error(`❌ Error proses tambah anggota #${item.id}:`, e);
    await markActionResult(item.id, 'failed', e?.message || 'Terjadi kesalahan tak terduga.');
  }
}

async function processKickMember(sock, groupId, item) {
  const jid = toJid(item.phone);
  try {
    const result = await sock.groupParticipantsUpdate(groupId, [jid], 'remove');
    const entry = Array.isArray(result) ? result[0] : null;
    const { ok, message } = describeParticipantStatus(entry?.status, 'kick');

    if (ok) {
      await markActionResult(item.id, 'success');
      console.log(`✅ Kick #${item.id}: ${item.phone} berhasil dikeluarkan.`);
    } else {
      await markActionResult(item.id, 'failed', message);
      console.log(`❌ Kick #${item.id}: ${message}`);
    }
  } catch (e) {
    console.error(`❌ Error proses kick anggota #${item.id}:`, e);
    await markActionResult(item.id, 'failed', e?.message || 'Terjadi kesalahan tak terduga.');
  }
}

async function reschedule(getSock, groupId) {
  const schedule = await getSchedule(groupId);

  // Hentikan job lama
  if (closeJob) closeJob.stop();
  if (openJob) openJob.stop();

  // Buat job buka grup. PENTING: getSock() dipanggil saat job BENERAN
  // jalan (waktu cron trigger), bukan saat di-schedule di sini. Jadi kalau
  // bot sempat reconnect di antara sekarang dan jam bukanya, job ini tetap
  // pakai socket yang lagi aktif, bukan socket lama yang sudah closed.
  openJob = cron.schedule(
    `${schedule.open_minute} ${schedule.open_hour} * * *`,
    () => openGroup(getSock, groupId, schedule.close_hour),
    { timezone: TIMEZONE }
  );

  // Buat job tutup grup
  closeJob = cron.schedule(
    `${schedule.close_minute} ${schedule.close_hour} * * *`,
    () => closeGroup(getSock, groupId, schedule.open_hour),
    { timezone: TIMEZONE }
  );

  console.log(`⏰ Jadwal: buka ${schedule.open_hour}:${String(schedule.open_minute).padStart(2,'0')} | tutup ${schedule.close_hour}:${String(schedule.close_minute).padStart(2,'0')} WIB`);
}

// Kalau cron pas nembak di momen bot lagi reconnect (sock null / belum
// 'open'), tunggu sebentar dan cek ulang - daripada langsung gagal dengan
// error "Connection Closed". Dikasih beberapa percobaan dengan jeda.
async function waitForSock(getSock, { retries = 5, delayMs = 3000 } = {}) {
  for (let i = 0; i < retries; i++) {
    const sock = typeof getSock === 'function' ? getSock() : getSock;
    if (sock?.user) return sock;
    console.warn(`⏳ Socket belum siap, tunggu ${delayMs}ms... (percobaan ${i + 1}/${retries})`);
    await new Promise(r => setTimeout(r, delayMs));
  }
  return null;
}

async function openGroup(sockOrGetSock, groupId, closeHour) {
  const sock = await waitForSock(sockOrGetSock);
  if (!sock) {
    console.error('❌ Batal buka grup: socket tidak tersedia setelah beberapa percobaan.');
    return;
  }
  try {
    await sock.groupSettingUpdate(groupId, 'not_announcement');

    await sock.sendMessage(groupId, {
      text: OPEN_MESSAGE(closeHour)
    });

    console.log('✅ Grup dibuka & pesan dipasang');
  } catch (e) {
    console.error('Error buka grup:', e);
  }
}

async function closeGroup(sockOrGetSock, groupId, openHour) {
  const sock = await waitForSock(sockOrGetSock);
  if (!sock) {
    console.error('❌ Batal tutup grup: socket tidak tersedia setelah beberapa percobaan.');
    return;
  }
  try {
    // Cek dulu apakah bot masih admin. Kalau bukan admin, groupSettingUpdate
    // dan pin di bawah bakal gagal (seringnya diam-diam tanpa error jelas).
    // Catatan: sekarang WA punya 2 format JID (@s.whatsapp.net & @lid),
    // jadi bot harus dicocokkan ke KEDUA kemungkinan biar gak salah deteksi.
    try {
      const metadata = await sock.groupMetadata(groupId);
      const candidateIds = [sock.user?.id, sock.user?.lid]
        .filter(Boolean)
        .map(id => id.split(':')[0]); // buang suffix device (:xx)

      const botParticipant = metadata.participants.find(p => {
        // v7 Baileys: participant bisa punya id (LID/PN), plus field phoneNumber terpisah
        const pIds = [p.id, p.phoneNumber, p.lid]
          .filter(Boolean)
          .map(id => id.split(':')[0]);
        return pIds.some(pId =>
          candidateIds.some(c => pId === c || pId.split('@')[0] === c.split('@')[0])
        );
      });

      const isAdmin = botParticipant?.admin === 'admin' || botParticipant?.admin === 'superadmin';
      if (!isAdmin) {
        console.warn('⚠️ Bot bukan admin grup (atau ID bot tidak ketemu di daftar peserta) — groupSettingUpdate & pin kemungkinan akan gagal!');
      }
    } catch (metaErr) {
      console.warn('⚠️ Gagal cek status admin bot:', metaErr);
    }

    await sock.groupSettingUpdate(groupId, 'announcement');

    // Ambil daftar nomor yang masih dalam masa tunggu promosi, dikelompokkan per tanggal
    const schedule = await getSchedule(groupId);
    const promoGroups = await getGroupedActiveCooldowns(schedule);

    const sent = await sock.sendMessage(groupId, {
      text: CLOSE_MESSAGE(openHour, promoGroups)
    });

    // Pin pesan 24 jam - key harus ada DI DALAM object `pin`, bukan di parameter kedua
    if (sent?.key) {
      // Kasih jeda sebentar sebelum pin. Kalau langsung pin detik itu juga,
      // kadang request ditolak diam-diam karena pesan belum "settle" di server WA.
      await new Promise(resolve => setTimeout(resolve, 1500));

      try {
        const pinResult = await sock.sendMessage(groupId, {
          pin: { type: 1, time: 86400, key: sent.key }
        });
        console.log('📌 Hasil pin:', JSON.stringify(pinResult));
      } catch (pinErr) {
        console.error('❌ Gagal pin pesan close:', pinErr);
      }
    } else {
      console.warn('⚠️ Tidak ada key dari pesan close, pin dilewati.');
    }

    console.log('✅ Grup ditutup & pesan dipasang');
  } catch (e) {
    console.error('Error tutup grup:', e);
  }
}

module.exports = { startScheduler };
