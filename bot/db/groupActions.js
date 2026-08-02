const supabase = require('../supabase');

// Ambil aksi (tambah/kick anggota) yang masih 'pending', diminta dari dashboard
async function getPendingActions(groupId) {
  const { data, error } = await supabase
    .from('group_actions')
    .select('*')
    .eq('group_id', groupId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('❌ Gagal fetch group_actions:', error);
    return [];
  }
  return data || [];
}

async function markActionResult(id, status, errMessage = null) {
  const { error } = await supabase
    .from('group_actions')
    .update({
      status,
      error: errMessage ? String(errMessage).slice(0, 500) : null,
      processed_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) console.error('❌ Gagal update status group_actions:', error);
}

module.exports = { getPendingActions, markActionResult };
