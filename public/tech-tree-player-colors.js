// UIColors.json / ColorTables / Icons. Random selection excludes player 7.
export const playerColors = Object.freeze([
  [0,0,255],[255,0,0],[0,255,0],[215,215,30],
  [126,242,225],[150,15,250],[99,103,112],[255,180,21]
]);
export const allowedPlayerColors=Object.freeze([1,2,3,4,5,6,8]);
export function randomPlayerColor(random=Math.random) {
  return allowedPlayerColors[Math.min(6,Math.max(0,Math.floor(random()*7)))];
}

// DDS AlphaPlayerColor stores inverse player-colour weight in alpha, rather
// than conventional transparency. Work from original RGBA bytes, since normal
// browser image decoding discards RGB in pixels whose alpha is zero.
export function colorPortrait(source,colorId,cutout=null) {
  const color=playerColors[colorId-1];
  if (!color || source.length!==256*256*4) throw new Error('无效的玩家配色数据');
  const output=new Uint8ClampedArray(source.length);
  if (cutout && cutout.length!==source.length) throw new Error('无效的透明 PNG 数据');
  for (let i=0;i<source.length;i+=4) {
    const original=source[i+3]/255,alpha=cutout?cutout[i+3]:255;
    for (let c=0;c<3;c++) output[i+c]=alpha?Math.min(255,Math.round(source[i+c]*(original+(1-original)*color[c]/255)*255/alpha)):0;
    output[i+3]=alpha;
  }
  return output;
}

const textures=new Map();
export const portraitAssetVersion='185872-png1';
export const portraitAssetUrl=icon=>`${icon.replace('/Unit/','/portraits-png/')}?v=${portraitAssetVersion}`;

async function loadTexture(url) {
  const image=new Image();image.decoding='async';image.src=url;
  await image.decode();
  const canvas=document.createElement('canvas');canvas.width=512;canvas.height=256;
  const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0);
  const packed=context.getImageData(0,0,512,256).data;
  const source=new Uint8ClampedArray(256*256*4);
  for(let y=0;y<256;y++)for(let x=0;x<256;x++){
    const i=(y*256+x)*4,left=(y*512+x)*4,right=left+256*4;
    source[i]=packed[left];source[i+1]=packed[left+1];source[i+2]=packed[left+2];source[i+3]=packed[right];
  }
  return source.buffer;
}

export async function renderPlayerPortrait(image,colorId) {
  // Older open pages may still refer to the previous WebP URL.
  const source=image.dataset.portrait.replace('/portraits/','/portraits-png/').replace(/\.webp$/i,'.png');
  if (image.dataset.portrait!==source) {image.dataset.portrait=source;image.src=source;}
  const path=new URL(source,location.href);
  path.pathname=path.pathname.replace('/portraits-png/','/portraits-textures/');
  path.searchParams.set('v',portraitAssetVersion);
  const url=path.href;
  if (!textures.has(url)) textures.set(url,loadTexture(url).catch(error=>{textures.delete(url);throw error;}));
  const [buffer]=await Promise.all([textures.get(url),image.decode()]);
  const bytes=new Uint8ClampedArray(buffer);
  if (!image.isConnected) return;
  const canvas=document.createElement('canvas');canvas.width=canvas.height=256;
  const context=canvas.getContext('2d');
  context.drawImage(image,0,0);
  const cutout=context.getImageData(0,0,256,256).data;
  context.putImageData(new ImageData(colorPortrait(bytes,colorId,cutout),256,256),0,0);
  image.src=canvas.toDataURL('image/png');
  await image.decode();
  image.dataset.colorReady='true';
}
