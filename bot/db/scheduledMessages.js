const supabase = require('../supabase');

// Ambil pesan yang statusnya masih 'pending' dan sudah lewat/masuk waktu kirimnya
async function getDueMessages(groupId) {
  const { data, error } = await supabase
    .from('scheduled_messages')
    .select('*')
    .eq('group_id', groupId)
    .eq('status', 'pending')
    .lte('send_at', new Date().toISOString())
    .order('send_at', { ascending: true });

  if (error) {
    console.error('❌ Gagal fetch scheduled_messages:', error);
    return [];
  }
  return data || [];
}

async function markSent(id) {
  const { error } = await supabase
    .from('scheduled_messages')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', id);
  if (error) console.error('❌ Gagal update status sent:', error);
}

async function markFailed(id, errMessage) {
  const { error } = await supabase
    .from('scheduled_messages')
    .update({ status: 'failed', error: String(errMessage).slice(0, 500) })
    .eq('id', id);
  if (error) console.error('❌ Gagal update status failed:', error);
}

module.exports = { getDueMessages, markSent, markFailed };
