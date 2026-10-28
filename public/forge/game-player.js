const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// The game keeps its own opaque origin. Only the frame dimensions and player
// controls belong to the platform; no game scripts run in the parent page.
export function gamePlayer(url,title='游戏试玩'){
  return `<section class="game-player" aria-label="${escape(title)}"><div class="game-player-toolbar"><span>9:16 竖屏试玩</span><button type="button" data-player-reload>重新载入</button><button type="button" data-player-fullscreen>全屏</button></div><div class="game-player-stage"><iframe class="product-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" allow="autoplay" title="${escape(title)}" src="${escape(url)}"></iframe></div></section>`;
}

export function bindGamePlayers(root){
  root.querySelectorAll('.game-player').forEach(player=>{
    if(player.dataset.bound)return;player.dataset.bound='1';
    const frame=player.querySelector('iframe');
    player.querySelector('[data-player-reload]').onclick=()=>{frame.src=frame.getAttribute('src');};
    const fullscreen=player.querySelector('[data-player-fullscreen]');
    fullscreen.hidden=!player.requestFullscreen;
    fullscreen.onclick=async()=>{try{if(document.fullscreenElement===player)await document.exitFullscreen();else await player.requestFullscreen();}catch{fullscreen.textContent='当前浏览器不支持全屏';}};
  });
}
