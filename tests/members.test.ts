import{describe,expect,it}from'vitest';
import{createMember,memberLogin,identity,updateMember,publicMember}from'../server/members';
import type{Member,MemberStore}from'../server/members';
import{authApi}from'../server/auth-api';
import{adminApi}from'../server/admin-api';
import{login}from'../server/settings';
import type{ConfigStore}from'../server/settings';

const secrets={ADMIN_PASSWORD:'test-only-admin',SETTINGS_KEY:'test-only-secret'};
function memoryStore():MemberStore{const all:Member[]=[];return{list:async()=>all,byId:async id=>all.find(m=>m.id===id)||null,byUsername:async username=>all.find(m=>m.username===username)||null,save:async member=>{const i=all.findIndex(m=>m.id===member.id);if(i<0)all.push(member);else all[i]=member;}};}
const config:ConfigStore={get:async()=>null,set:async()=>{}};
describe('成员账号与权限',()=>{
  it('默认每天50次，调额保留会话；0暂停新审核且拒绝非法额度',async()=>{
    const store=memoryStore();const member=await createMember({username:'quota01',password:'test-only-password'},store);
    expect(publicMember(member).dailyReviewLimit).toBe(50);
    const token=await memberLogin(member.username,'test-only-password',store,secrets.SETTINGS_KEY);
    await updateMember(member.id,{dailyReviewLimit:0},store);
    expect(await identity(`pgc_member=${token}`,store,secrets)).toMatchObject({role:'member'});
    expect(member.dailyReviewLimit).toBe(0);
    for(const value of [-1,1.2,'50',10001])await expect(updateMember(member.id,{dailyReviewLimit:value},store)).rejects.toThrow('每日审核次数');
  });
  it('开通账号后可登录，公开数据不包含密码摘要或盐',async()=>{
    const store=memoryStore();const member=await createMember({username:'Creator01',displayName:'测试创作者',password:'test-only-password'},store);
    expect(member.username).toBe('creator01');expect(member.passwordHash).not.toContain('test-only-password');
    expect(JSON.stringify(publicMember(member))).not.toMatch(/passwordHash|passwordSalt|sessionVersion/);
    expect(await memberLogin('creator01','wrong-password',store,secrets.SETTINGS_KEY)).toBe(null);
    const token=await memberLogin('creator01','test-only-password',store,secrets.SETTINGS_KEY);
    expect(await identity(`pgc_member=${token}`,store,secrets)).toMatchObject({role:'member',canReview:true});
    expect(await identity(`pgc_member=${token}x`,store,secrets)).toBe(null);
  });
  it('停用、收回权限、重置密码会撤销旧会话',async()=>{
    const store=memoryStore();const member=await createMember({username:'creator02',password:'test-only-password'},store);
    const token=await memberLogin('creator02','test-only-password',store,secrets.SETTINGS_KEY);
    await updateMember(member.id,{canReview:false},store);
    expect(await identity(`pgc_member=${token}`,store,secrets)).toBe(null);
    const noReview=await memberLogin('creator02','test-only-password',store,secrets.SETTINGS_KEY);
    expect(await identity(`pgc_member=${noReview}`,store,secrets)).toMatchObject({canReview:false});
    await updateMember(member.id,{password:'new-test-only-password'},store);
    expect(await memberLogin('creator02','test-only-password',store,secrets.SETTINGS_KEY)).toBe(null);
    await updateMember(member.id,{enabled:false},store);
    expect(await memberLogin('creator02','new-test-only-password',store,secrets.SETTINGS_KEY)).toBe(null);
  });
  it('成员不能调用管理接口，跨站提交被拒绝',async()=>{
    const store=memoryStore();await createMember({username:'creator03',password:'test-only-password'},store);
    const token=await memberLogin('creator03','test-only-password',store,secrets.SETTINGS_KEY);
    const response=await adminApi(new Request('https://pgc.example/api/admin/members',{headers:{Cookie:`pgc_member=${token}`}}),config,secrets,store);
    expect(response?.status).toBe(401);
    const cross=await authApi(new Request('https://pgc.example/api/auth/login',{method:'POST',headers:{Origin:'https://other.example','Content-Type':'application/json'},body:'{}'}),store,secrets);
    expect(cross?.status).toBe(403);
  });
  it('管理员能开通账号，成员自行改密后需重新登录',async()=>{
    const store=memoryStore();const admin=await login(secrets.ADMIN_PASSWORD,secrets);
    const created=await adminApi(new Request('https://pgc.example/api/admin/members',{method:'POST',headers:{Origin:'https://pgc.example','Content-Type':'application/json',Cookie:`pgc_admin=${admin}`},body:JSON.stringify({username:'creator04',displayName:'测试成员',password:'test-only-password'})}),config,secrets,store);
    expect(created?.status).toBe(201);expect(JSON.stringify(await created!.json())).not.toContain('passwordHash');
    const token=await memberLogin('creator04','test-only-password',store,secrets.SETTINGS_KEY);
    const changed=await authApi(new Request('https://pgc.example/api/auth/password',{method:'PUT',headers:{Origin:'https://pgc.example','Content-Type':'application/json',Cookie:`pgc_member=${token}`},body:JSON.stringify({currentPassword:'test-only-password',newPassword:'new-test-only-password'})}),store,secrets);
    expect(changed?.status).toBe(200);expect(await identity(`pgc_member=${token}`,store,secrets)).toBe(null);
    expect(await memberLogin('creator04','new-test-only-password',store,secrets.SETTINGS_KEY)).toBeTruthy();
  });
});
