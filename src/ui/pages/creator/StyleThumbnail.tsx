import {useState} from 'react';
import {Image as ImageIcon, Maximize2, PencilLine, Play, RefreshCw} from 'lucide-react';
import {Dialog} from '../../components/ui';
import {forge, titleOf, type Topic} from './model';

/** Read the adopted style image only; opening a shelf never fetches game HTML. */
type ThumbnailProps={topic:Topic;onPlay?:()=>void;onContinue?:()=>void};
export function StyleThumbnail({topic,onPlay,onContinue}: ThumbnailProps) {
  return <Thumbnail key={`${topic.id}:${topic.updated_at}:${topic.has_preview}`} topic={topic} onPlay={onPlay} onContinue={onContinue}/>;
}

function Thumbnail({topic,onPlay,onContinue}: ThumbnailProps) {
  const [open,setOpen]=useState(false),[failed,setFailed]=useState(false),[attempt,setAttempt]=useState(0);
  const title=titleOf(topic);
  const src=`${forge}/topics/${topic.id}/preview-thumbnail?revision=${encodeURIComponent(topic.updated_at||'current')}&attempt=${attempt}`;
  const preview=<Dialog open={open} onOpenChange={setOpen} title={`${title} · 样板图`} description="当前已采用的美术样板，可用于辨认作品的画面与配色。">
    {open&&<img className="creator-style-enlarged" src={src} alt={`${title}的当前样板图`} referrerPolicy="no-referrer" onError={()=>{setFailed(true);setOpen(false);}}/>}
  </Dialog>;
  const primaryAction=onPlay||onContinue;
  const ActionIcon=onPlay?Play:PencilLine;
  if(primaryAction)return <>
    <div className="creator-product-cover">
      <button type="button" className="creator-style-thumb creator-product-play" aria-label={`${onPlay?'试玩':'继续创作'} ${title}`} onClick={event=>{event.currentTarget.focus();primaryAction();}}>
        {topic.has_preview&&!failed?<img src={src} alt={`${title}的样板图封面`} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={()=>setFailed(true)}/>:<span className="creator-product-cover-empty"><ImageIcon size={28} aria-hidden/>{failed?'样板图暂未载入':'尚无样板图'}</span>}
        <span className="creator-product-play-label"><ActionIcon size={17} aria-hidden/>{onPlay?'点击试玩':'继续创作'}</span>
      </button>
      {Boolean(topic.has_preview)&&<button type="button" className="creator-product-style-link" aria-label={`${failed?'重新载入':'放大查看'} ${title} 的样板图`} onClick={()=>{if(failed){setAttempt(value=>value+1);setFailed(false);}else setOpen(true);}}>{failed?<RefreshCw size={13} aria-hidden/>:<Maximize2 size={13} aria-hidden/>}{failed?'重载封面':'样板图'}</button>}
    </div>
    {preview}
  </>;
  if(!topic.has_preview)return <div className="creator-style-thumb is-empty"><ImageIcon size={22} aria-hidden/><span>尚无样板图</span></div>;
  return <>
    <button type="button" className={`creator-style-thumb ${failed?'is-empty is-failed':''}`} aria-label={`${failed?'重新载入':'放大查看'} ${title} 的样板图`} onClick={()=>{if(failed){setAttempt(value=>value+1);setFailed(false);}else setOpen(true);}}>
      {failed?<><RefreshCw size={20} aria-hidden/><span>重新载入样板图</span></>:<><img src={src} alt={`${title}的当前样板图`} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={()=>setFailed(true)}/><span className="creator-style-thumb-label"><Maximize2 size={12} aria-hidden/>样板图</span></>}
    </button>
    {preview}
  </>;
}
