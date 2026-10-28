// Administrator DTOs contain presentation metadata. Artifact source is fetched
// only through the selected material endpoint, never through lists or totals.
export type AdminRange='today'|'7d'|'30d'|'all';
export type AdminView='overview'|'works'|'tasks'|'reviews'|'members'|'settings';
export type MaterialKind='expand'|'game'|'preview'|'brief'|'assets';
export interface AdminMemberOption {id:string;displayName:string;username:string;enabled:boolean;star:boolean}
export interface AdminProject {
  id:number;type:'topic'|'game';ownerId:string;ownerName:string;title:string;subject:string;
  summary:string;status:string;statusLabel:string;updatedAt:string;createdAt:string|null;
  materials:Record<MaterialKind,boolean>;thumbnailUrl:string|null;
  activeTasks:number;failedTasks:number;
}
export interface AdminVersion {id:string;kind:string;created_at:string;executor:string;model?:string;current:boolean;disposition:string;stale?:boolean;restored_from?:string|null}
export interface AdminProjectDetail {
  project:AdminProject;overview:Record<string,unknown>;versions:AdminVersion[];
  relatedReviews:Array<{id:number;title:string;score:number|null;createdAt:string}>;
}
export interface AdminMaterial {kind:MaterialKind;available:boolean;content?:string;previewUrl?:string;downloadUrl?:string;versionId?:string}
export interface AdminTask {
  id:string;type:'creation'|'review';kind:string;kindLabel:string;ownerId:string;ownerName:string;
  projectId:number|null;projectType:'topic'|'game'|null;title:string;executor:'platform'|'agent';
  status:string;statusLabel:string;detail:string;error:string;createdAt:string;updatedAt:string;startedAt:string|null;
  resultId?:number|null;canRetry:boolean;retryReason:string;retryOf?:string|null;requestedBy?:string|null;
}
export interface AdminTaskDetail {task:AdminTask;retryTaskId:string|null;sourceAvailable:boolean;continuePrompt:string|null}
export interface AdminPage<T> {items:T[];total:number;page:number;pageSize:number;members:AdminMemberOption[];updatedAt:string;activeCount:number;waitingAgentCount:number}
export interface AdminDashboard {
  range:AdminRange;timeZone:'Asia/Shanghai';updatedAt:string;members:AdminMemberOption[];
  metrics:{productiveMembers:number;newProducts:number;failedTasks:number;activeTasks:number};
  progress:Array<{id:string;displayName:string;username:string;star:boolean;enabled:boolean;creations:number;reviews:number;products:number;activeTasks:number;currentTask:string|null;lastActivity:string|null}>;
  latestProducts:AdminProject[];attention:AdminTask[];waitingAgentCount:number;
}
export interface AdminRoute {
  view:AdminView;range:AdminRange;owner:string;q:string;status:string;type:string;page:number;
  id?:string;panel?:string;version?:string;layout?:'grid'|'list';section?:string;
}
export interface AdminContext {
  root:HTMLElement;route:AdminRoute;signal:AbortSignal;
  api<T=any>(path:string,method?:string,body?:unknown):Promise<T>;
  navigate(changes:Partial<AdminRoute>,replace?:boolean):void;
  setRefresh(callback:(()=>Promise<void>)|null,mode?:'active'|'agent'|'idle'):void;
  notice(message:string,error?:boolean):void;
}
