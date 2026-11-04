import {createHash,createHmac,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm,readdir,lstat} from 'node:fs/promises';
import {join} from 'node:path';
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const canonical=(value:any):string=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?`[${value.map(canonical).join(',')}]`:`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
const validHash=(value:any)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
// Per credential and job: never reuse a different owner's material or images.
export class ReviewMaterialCache{
  readonly directory:string;
  private credential:string;
  constructor(root:string,credential:string,job:string){if(!/^[a-f0-9-]{36}$/.test(job))throw new Error('Invalid job');this.credential=credential;this.directory=join(root,hash(credential),job);}
  async touch(){
    await mkdir(this.directory,{recursive:true,mode:0o700});const path=join(this.directory,'activity.json'),now=Date.now();let createdAt=now;try{const old=JSON.parse(await readFile(path,'utf8'));if(Number.isFinite(old.createdAt))createdAt=old.createdAt;}catch{}
    const temp=`${path}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify({createdAt,lastActiveAt:now}),{mode:0o600});await rename(temp,path);
  }
  async remove(){await rm(this.directory,{recursive:true,force:true});}
  async save(path:string,value:string|Buffer){await mkdir(this.directory,{recursive:true,mode:0o700});const temp=`${path}.${randomUUID()}.tmp`;await writeFile(temp,value,{mode:0o600});await rename(temp,path);await this.touch();}
  async image(digest:string){if(!validHash(digest))throw new Error('Invalid image hash');for(const extension of ['jpg','png','webp']){const path=join(this.directory,`${digest}.${extension}`);let bytes:Buffer;try{bytes=await readFile(path);}catch{continue;}if(hash(bytes)===digest)return path;}throw new Error('Cached image missing or changed');}
  async capture(shots:any[]){for(const shot of shots){const match=String(shot.data).match(/^data:image\/(jpeg|png|webp);base64,(.*)$/s);if(!match)throw new Error('Invalid image');const bytes=Buffer.from(match[2],'base64');await this.save(join(this.directory,`${hash(bytes)}.${match[1]==='jpeg'?'jpg':match[1]}`),bytes);}}
  async read(){try{await this.touch();const value=JSON.parse(await readFile(join(this.directory,'manifest.json'),'utf8'));const {signature,...payload}=value;if(signature!==createHmac('sha256',this.credential).update(canonical(payload)).digest('hex'))throw new Error('Cached manifest changed');if(!validHash(value.materialHash)||!validHash(value.evidenceHash)||hash(canonical(value.snapshot))!==value.materialHash)throw new Error('Cached material changed');for(const item of value.images)await this.image(item.sha256);return value;}catch{return null;}}
  async knownImages(){const {readdir}=await import('node:fs/promises');const result:string[]=[];try{for(const name of await readdir(this.directory)){const digest=name.replace(/\.(jpg|png|webp)$/,'');if(validHash(digest))try{await this.image(digest);result.push(digest);}catch{}}}catch{}return result.slice(0,16);}
  async accept(value:any,cached:any){
    const base=value.mode==='delta'?cached:value;
    if(!base||base.materialHash!==value.materialHash||base.evidenceHash!==value.evidenceHash||hash(canonical(base.snapshot))!==value.materialHash)throw new Error('Material manifest mismatch');
    for(const item of base.images){if(item.data)await this.capture([{data:item.data}]);await this.image(item.sha256);}
    const clean={materialHash:value.materialHash,evidenceHash:value.evidenceHash,snapshot:base.snapshot,images:base.images.map(({data,...item}:any)=>item)};
    await this.save(join(this.directory,'manifest.json'),JSON.stringify({...clean,signature:createHmac('sha256',this.credential).update(canonical(clean)).digest('hex')}));return clean;
  }
}

// Enumerate directory names only; read/delete at most `limit` cache entries per
// invocation. A rotating cursor also reaches old credential namespaces. No
// user-selected output, source HTML, claims or outbox is inside this root.
export async function pruneReviewMaterialCaches(root:string,now=Date.now(),limit=64){
  let scopes;try{scopes=await readdir(root,{withFileTypes:true});}catch{return 0;}
  const entries:string[]=[];
  for(const scope of scopes)if(scope.isDirectory()&&validHash(scope.name)){
    for(const job of await readdir(join(root,scope.name),{withFileTypes:true}).catch(()=>[]))if(job.isDirectory()&&/^[a-f0-9-]{36}$/.test(job.name))entries.push(`${scope.name}/${job.name}`);
  }
  entries.sort();if(!entries.length)return 0;const cursorPath=join(root,'cleanup-cursor.json');let after='';try{after=JSON.parse(await readFile(cursorPath,'utf8')).after||'';}catch{}
  let index=entries.findIndex(name=>name>after);if(index<0)index=0;let removed=0,last=after;
  for(let n=0;n<Math.min(Math.max(0,limit),entries.length);n++){
    const relative=entries[(index+n)%entries.length],path=join(root,relative);last=relative;
    try{
      const parent=await lstat(join(root,relative.split('/')[0])),info=await lstat(path);if(!parent.isDirectory()||parent.isSymbolicLink()||!info.isDirectory()||info.isSymbolicLink())continue;
      let lastActive=info.mtimeMs;try{const marker=await lstat(join(path,'activity.json'));if(marker.isSymbolicLink())continue;const value=JSON.parse(await readFile(join(path,'activity.json'),'utf8'));if(Number.isFinite(value.lastActiveAt))lastActive=Math.max(lastActive,value.lastActiveAt);}catch{}
      if(now-lastActive>86400000){await rm(path,{recursive:true,force:true});removed++;}
    }catch{/* A concurrent terminal cleanup may already have removed it. */}
  }
  const temp=`${cursorPath}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify({after:last}),{mode:0o600});await rename(temp,cursorPath);return removed;
}
