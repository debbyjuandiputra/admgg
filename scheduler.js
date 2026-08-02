const cron = require('node-cron');
const { getSchedule } = require('./db/schedule');
const { getGroupedActiveCooldowns } = require('./db/promoLog');
const { getDueMessages, markSent, markFailed } = require('./db/scheduledMessages');
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

  // Cek pesan terjadwal (dari dashboard) tiap 1 menit
  startMessageQueueWorker(getSock, groupId);
}

// ─── PESAN TERJADWAL DARI DASHBOARD ─────────────────────────────
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
