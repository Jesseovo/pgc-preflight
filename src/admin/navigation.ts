import type {AdminInspector,AdminRoute,AdminView} from './contracts';

export const viewLabels:Record<AdminView,string>={overview:'总览',works:'作品',tasks:'任务',reviews:'审核',members:'成员',settings:'平台设置'};
export function readRoute(search:string):AdminRoute{
  const q=new URLSearchParams(search),view=(Object.hasOwn(viewLabels,q.get('view')||'')?q.get('view'):'overview') as AdminView;
  const range=q.get('range');
  const route:AdminRoute={view,range:(['today','7d','30d','all'].includes(range||'')?range:view==='overview'?'today':'all') as AdminRoute['range'],owner:q.get('owner')||'',q:q.get('q')||'',status:q.get('status')||'all',type:q.get('type')||'all',page:Math.max(1,Number.parseInt(q.get('page')||'1',10)||1),id:q.get('id')||undefined,panel:q.get('panel')||undefined,version:q.get('version')||undefined,layout:q.get('layout')==='grid'?'grid':'list',section:q.get('section')||undefined};
  const kind=q.get('inspect'),id=q.get('inspectId'),type=q.get('inspectType');
  if(id&&((kind==='project'&&(type==='topic'||type==='game'))||(kind==='task'&&(type==='creation'||type==='review'))||kind==='report')){
    route.inspector={kind:kind as AdminInspector['kind'],id,type:kind==='report'?undefined:type as AdminInspector['type'],panel:q.get('inspectPanel')||undefined,version:q.get('inspectVersion')||undefined};
  }
  return route;
}
export function routeUrl(route:AdminRoute):string{
  const q=new URLSearchParams({view:route.view});
  for(const [key,value] of Object.entries(route)){
    if(key==='view'||key==='inspector'||value===undefined||value===''||value==='all'||(key==='page'&&value===1)||(key==='layout'&&value==='list'))continue;
    q.set(key,String(value));
  }
  if(route.inspector){const i=route.inspector;q.set('inspect',i.kind);q.set('inspectId',i.id);if(i.type)q.set('inspectType',i.type);if(i.panel)q.set('inspectPanel',i.panel);if(i.version)q.set('inspectVersion',i.version);}
  return '/admin?'+q;
}
export function baseRoute(route:AdminRoute):AdminRoute{return {...route,inspector:undefined};}
export function inspectorRoute(i:AdminInspector):AdminRoute{
  return {view:i.kind==='project'?'works':i.kind==='task'?'tasks':'reviews',id:i.id,type:i.type||'all',panel:i.panel,version:i.version,range:'all',owner:'',q:'',status:'all',page:1,layout:'list'};
}
export function detailTarget(changes:Partial<AdminRoute>,current:AdminRoute):AdminInspector|undefined{
  const view=changes.view||current.view,id=changes.id;
  if(!id)return;
  if(view==='works')return {kind:'project',id,type:changes.type==='game'?'game':changes.type==='topic'?'topic':current.type==='game'?'game':'topic',panel:changes.panel,version:changes.version};
  if(view==='tasks')return {kind:'task',id,type:changes.type==='review'?'review':changes.type==='creation'?'creation':current.type==='review'?'review':'creation'};
  if(view==='reviews')return {kind:'report',id};
}
