import {useState} from 'react';
import {GamePlayer} from '../../components/GamePlayer';
import {Badge, Button, Dialog, ErrorState, Loading} from '../../components/ui';
import {useResource} from '../../lib/api';
import {StyleThumbnail} from './StyleThumbnail';
import {displayDate, forge, titleOf, type Topic, type Version} from './model';

export function ProductCard({topic,onProject}:{topic:Topic;onProject:()=>void}) {
  const [playing,setPlaying]=useState(false);
  return <article className="creator-project-card creator-product-card">
    <div className="creator-project-mast"><span>作品 {String(topic.id).padStart(3,'0')}</span><Badge tone="sage">可试玩</Badge></div>
    <StyleThumbnail topic={topic} onPlay={()=>setPlaying(true)}/>
    <div className="creator-row-copy"><button className="creator-title-link" onClick={event=>{event.currentTarget.focus();setPlaying(true);}}>{titleOf(topic)}</button><p>{topic.data?.logline||topic.subject||'已生成的游戏成品'}</p><small className="muted">{displayDate(topic.updated_at)}</small></div>
    <Button variant="ghost" size="sm" onClick={onProject}>查看项目 →</Button>
    {playing&&<ProductPlay topic={topic} onClose={()=>setPlaying(false)}/>}
  </article>;
}

function ProductPlay({topic,onClose}:{topic:Topic;onClose:()=>void}) {
  const versions=useResource<Version[]>(`${forge}/topics/${topic.id}/versions`);
  const current=versions.data?.find(version=>version.kind==='game'&&(version.current??version.disposition==='current'));
  const src=current?`${forge}/topics/${topic.id}/versions/${encodeURIComponent(current.id)}/preview`:`${forge}/topics/${topic.id}/product-preview`;
  return <Dialog open onOpenChange={open=>{if(!open)onClose();}} title={titleOf(topic)}>
    <div className="creator-product-player">
      {versions.error?<ErrorState error={versions.error} onRetry={versions.reload}/>:versions.loading?<Loading label="正在打开游戏…"/>:<GamePlayer src={src} title={titleOf(topic)} versionKey={current?.id||topic.id}/>}
    </div>
  </Dialog>;
}
