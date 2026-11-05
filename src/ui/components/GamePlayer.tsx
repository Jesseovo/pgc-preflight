import {memo,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Maximize,RotateCcw} from 'lucide-react';
import {Button} from './ui';
import {toast} from '../lib/api';

const policy="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
function isolatedDocument(html:string){return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0">${html}</body></html>`;}
export const GamePlayer=memo(function GamePlayer({src,html,title='游戏试玩',versionKey}:{src?:string;html?:string;title?:string;versionKey?:string|number}){
 const host=useRef<HTMLDivElement>(null),viewport=useRef<HTMLDivElement>(null),frame=useRef<HTMLIFrameElement>(null),[reload,setReload]=useState(0),[fullscreen,setFullscreen]=useState(false);
 const canFullscreen=typeof window.document.documentElement.requestFullscreen==='function';
 useEffect(()=>{const doc=host.current?.ownerDocument;if(!doc)return;const update=()=>setFullscreen(doc.fullscreenElement===host.current);doc.addEventListener('fullscreenchange',update);return()=>doc.removeEventListener('fullscreenchange',update);},[]);
 const document=useMemo(()=>html===undefined?undefined:isolatedDocument(html),[html]);
 const safeSrc=useMemo(()=>{if(!src)return undefined;try{const url=new URL(src,location.origin);return url.origin===location.origin&&/^\/api\/(forge|admin|square)\//.test(url.pathname)?url.href:undefined;}catch{return undefined;}},[src]);
 useLayoutEffect(()=>{const el=viewport.current;if(!el)return;const resize=()=>{if(frame.current)frame.current.style.transform=`scale(${el.clientWidth/540})`;};const observer=new ResizeObserver(resize);observer.observe(el);resize();return()=>observer.disconnect();},[reload,versionKey,safeSrc,document]);
 return <section className="game-player" ref={host} aria-label={title}><div className="player-toolbar"><span>{title}</span><div className="row"><Button size="icon" variant="ghost" aria-label="重新开始试玩" title="重新开始" onClick={()=>setReload(n=>n+1)}><RotateCcw size={17}/></Button>{canFullscreen&&<Button size="icon" variant="ghost" aria-label={fullscreen?"退出全屏试玩":"全屏试玩"} title={fullscreen?"退出全屏":"全屏"} onClick={async()=>{try{const el=host.current;if(!el)return;if(el.ownerDocument.fullscreenElement===el)await el.ownerDocument.exitFullscreen();else await el.requestFullscreen();}catch{toast("当前浏览器未能进入全屏，仍可在播放器内试玩。","info");}}}><Maximize size={17}/></Button>}</div></div><div className="player-viewport" ref={viewport} style={{width:'min(100%, 420px, max(90px, calc((100dvh - 180px) * .5625)))',maxWidth:'100%',height:'auto',aspectRatio:'9 / 16'}}>{safeSrc||document?<iframe ref={frame} key={`${versionKey??''}:${reload}`} title={title} src={document?undefined:safeSrc} srcDoc={document} sandbox="allow-scripts" referrerPolicy="no-referrer" allow="autoplay" style={{width:540,height:960,transformOrigin:'top left'}}/>:<p className="muted">暂无可访问的试玩内容。</p>}</div><p className="player-caption">隔离试玩 · 9:16</p></section>;
});
export default GamePlayer;
