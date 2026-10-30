import {describe,expect,it} from 'vitest';
import {baseRoute,detailTarget,inspectorRoute,readRoute,routeUrl} from '../src/admin/navigation';

describe('管理员详情路由',()=>{
  it('独立保存背景作品筛选和任务类型，刷新序列化不串用字段',()=>{
    const route=readRoute('?view=works&owner=member-a&type=game&q=%E8%8A%B1&page=3&layout=grid&range=7d&inspect=task&inspectId=task-1&inspectType=review');
    expect(route).toMatchObject({view:'works',owner:'member-a',type:'game',q:'花',page:3,range:'7d',layout:'grid',inspector:{kind:'task',id:'task-1',type:'review'}});
    expect(readRoute(routeUrl(route).split('?')[1])).toEqual(route);
    expect(inspectorRoute(route.inspector!)).toMatchObject({view:'tasks',id:'task-1',type:'review',owner:'',range:'all'});
    expect(new URL(routeUrl(baseRoute(route)),'https://test.local').searchParams.has('inspect')).toBe(false);
  });
  it('分享链接保留所选不可变版本，同时兼容原有完整详情链接',()=>{
    const route=readRoute('?view=works&inspect=project&inspectId=41&inspectType=topic&inspectPanel=history&inspectVersion=immutable-1');
    expect(readRoute(routeUrl(route).split('?')[1])).toEqual(route);
    const full=inspectorRoute(route.inspector!);
    expect(readRoute(routeUrl(full).split('?')[1])).toMatchObject({view:'works',id:'41',type:'topic',panel:'history',version:'immutable-1'});
  });
  it('拒绝不匹配的详情种类和类型，不接收原型属性作为栏目',()=>{
    for(const query of ['inspect=project&inspectId=1&inspectType=review','inspect=task&inspectId=1&inspectType=game','inspect=unknown&inspectId=1','inspect=report'])expect(readRoute(query).inspector).toBeUndefined();
    expect(readRoute('view=constructor&page=-3')).toMatchObject({view:'overview',page:1});
    expect(readRoute('inspect=report&inspectId=81&inspectType=game').inspector).toEqual({kind:'report',id:'81',type:undefined,panel:undefined,version:undefined});
  });
  it('跨栏目打开详情时使用目标对象类型，保留当前列表路由',()=>{
    const current=readRoute('view=works&type=game&owner=member-a&page=2');
    expect(detailTarget({view:'tasks',id:'new-task',type:'creation'},current)).toEqual({kind:'task',id:'new-task',type:'creation'});
    expect(detailTarget({view:'reviews',id:'81'},current)).toEqual({kind:'report',id:'81'});
    expect(current).toMatchObject({view:'works',type:'game',owner:'member-a',page:2});
    expect(detailTarget({view:'members',id:'member-a'},current)).toBeUndefined();
  });
});
