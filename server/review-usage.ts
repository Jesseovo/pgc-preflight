// Metadata only: the quota and administrator ledger never retain game source.
export const reviewDay = (time = Date.now()) => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
export async function reviewUsage(DB:any, ownerId:string) {
  const day=reviewDay();
  const row=await DB.prepare('SELECT COUNT(*) AS used FROM review_jobs WHERE owner_id = ? AND usage_day = ? AND quota_charged = 1').bind(ownerId,day).first();
  const member=ownerId==='admin'?null:await DB.prepare('SELECT daily_review_limit FROM members WHERE id = ?').bind(ownerId).first();
  const limit=ownerId==='admin'?null:Number(member?.daily_review_limit??50),used=Number(row?.used||0);
  return {day,timeZone:'Asia/Shanghai',limit,used,remaining:limit===null?null:Math.max(0,limit-used)};
}
export async function reviewActivity(DB:any, params:URLSearchParams) {
  const day=params.get('date')||reviewDay();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||Number.isNaN(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day)throw new Error('日期格式不正确。');
  const member=params.get('member')||'';
  if(member&&!/^[a-f0-9-]{36}$/.test(member))throw new Error('成员标识不正确。');
  const page=Math.max(1,Math.min(100000,Number.parseInt(params.get('page')||'1',10)||1)),size=50;
  const where="j.usage_day = ? AND j.owner_id <> 'admin'"+(member?' AND j.owner_id = ?':'');
  const args=member?[day,member]:[day];
  const [rows,total,summary]=await Promise.all([
    DB.prepare(`SELECT j.id,j.owner_id,j.title,j.filename,j.status,j.stage,j.error,j.result_id,j.created_at,j.updated_at,j.quota_charged,m.username,m.display_name,r.score FROM review_jobs j LEFT JOIN members m ON m.id=j.owner_id LEFT JOIN reviews r ON r.id=j.result_id WHERE ${where} ORDER BY j.created_at DESC,j.id DESC LIMIT ? OFFSET ?`).bind(...args,size,(page-1)*size).all(),
    DB.prepare(`SELECT COUNT(*) AS n FROM review_jobs j WHERE ${where}`).bind(...args).first(),
    DB.prepare("SELECT m.id,m.username,m.display_name,m.daily_review_limit,COUNT(j.id) AS submitted,COALESCE(SUM(j.quota_charged),0) AS used,COALESCE(SUM(j.status='done'),0) AS completed,COALESCE(SUM(j.status='error'),0) AS failed,COALESCE(SUM(j.status IN ('queued','running')),0) AS active FROM members m LEFT JOIN review_jobs j ON j.owner_id=m.id AND j.usage_day=? GROUP BY m.id ORDER BY m.created_at DESC").bind(day).all(),
  ]);
  return {day,timeZone:'Asia/Shanghai',page,pageSize:size,total:Number(total?.n||0),records:rows.results||[],members:summary.results||[]};
}
