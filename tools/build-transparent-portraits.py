"""Build reviewed transparent PNG assets from the original game RGBA textures.

Unlike the old runtime dark-threshold flood fill, only the actual black matte
is removed. Nonzero dark foreground pixels are retained, and edge coverage is
estimated only in a one-pixel contour band. No original textures are modified.
"""
from collections import deque
import json
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter, ImageDraw

ROOT=Path(__file__).resolve().parents[1]


def cutout(source,outline=None,small_island_limit=20,smooth_specks=False):
    rgb=source[:,:,:3].astype(np.float32)
    maximum=rgb.max(axis=2)
    foreground=maximum>0
    # The game's thin neutral outline is limited to the image perimeter.
    neutral=(maximum-rgb.min(axis=2)<=8)&(maximum<=64)&(source[:,:,3]>=250)
    foreground[0,:]&=~neutral[0,:];foreground[-1,:]&=~neutral[-1,:]
    foreground[:,0]&=~neutral[:,0];foreground[:,-1]&=~neutral[:,-1]
    # Preserve small enclosed black facial/armour details. Large enclosed voids
    # are background between equipment and the body, and remain transparent.
    seen=foreground.copy()
    for y,x in zip(*np.where(~seen)):
        if seen[y,x]:continue
        queue=deque([(y,x)]);seen[y,x]=True;component=[];outside=False
        while queue:
            yy,xx=queue.popleft();component.append((yy,xx))
            outside|=yy==0 or xx==0 or yy==255 or xx==255
            for ny,nx in [(yy-1,xx),(yy+1,xx),(yy,xx-1),(yy,xx+1)]:
                if 0<=ny<256 and 0<=nx<256 and not seen[ny,nx]:
                    seen[ny,nx]=True;queue.append((ny,nx))
        if not outside and len(component)<=64:
            for yy,xx in component:foreground[yy,xx]=True
    if outline:
        # Hero backdrops and torch halos need separately reviewed contours;
        # neither is conventional black matte.
        contour=Image.new('L',(256,256),0)
        polygons=outline['polygons'] if isinstance(outline,dict) else [outline]
        for polygon in polygons:
            ImageDraw.Draw(contour).polygon([tuple(point) for point in polygon],fill=255)
        foreground&=np.asarray(contour)>0
    # The matte occasionally leaves tiny detached dark flecks. Remove only
    # islands of up to 20 pixels; larger separated weapons/ropes remain.
    visited=np.zeros((256,256),dtype=bool)
    for y,x in zip(*np.where(foreground)):
        if visited[y,x]:continue
        queue=deque([(int(y),int(x))]);visited[y,x]=True;island=[]
        while queue:
            yy,xx=queue.popleft();island.append((yy,xx))
            for ny,nx in ((yy-1,xx-1),(yy-1,xx),(yy-1,xx+1),(yy,xx-1),(yy,xx+1),(yy+1,xx-1),(yy+1,xx),(yy+1,xx+1)):
                if 0<=ny<256 and 0<=nx<256 and foreground[ny,nx] and not visited[ny,nx]:
                    visited[ny,nx]=True;queue.append((ny,nx))
        if len(island)<=small_island_limit:
            for yy,xx in island:foreground[yy,xx]=False
    if smooth_specks:
        foreground=np.asarray(Image.fromarray((foreground*255).astype(np.uint8)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3)))>0
        # Original mattes also have almost-black burrs attached to edges.
        # Clear only small dark clusters exposed to transparency; enclosed
        # armour, faces and other shading remain intact.
        dark=foreground&(maximum<24)
        checked=np.zeros((256,256),dtype=bool)
        for y,x in zip(*np.where(dark)):
            if checked[y,x]:continue
            queue=deque([(int(y),int(x))]);checked[y,x]=True;island=[];exposed=False
            while queue:
                yy,xx=queue.popleft();island.append((yy,xx))
                for ny,nx in ((yy-1,xx-1),(yy-1,xx),(yy-1,xx+1),(yy,xx-1),(yy,xx+1),(yy+1,xx-1),(yy+1,xx),(yy+1,xx+1)):
                    if not (0<=ny<256 and 0<=nx<256):continue
                    if not foreground[ny,nx]:exposed=True
                    if dark[ny,nx] and not checked[ny,nx]:checked[ny,nx]=True;queue.append((ny,nx))
            if exposed and len(island)<=20:
                for yy,xx in island:foreground[yy,xx]=False
    mask=Image.fromarray((foreground*255).astype(np.uint8))
    eroded=np.asarray(mask.filter(ImageFilter.MinFilter(3)))>0
    edge=foreground&~eroded
    neighbor=np.asarray(Image.fromarray(maximum.astype(np.uint8)).filter(ImageFilter.MaxFilter(3))).astype(np.float32)
    alpha=np.where(foreground,255.,0.)
    alpha[edge]=np.clip(maximum[edge]/np.maximum(neighbor[edge],1)*255,1,255)
    # Default PNG uses player 1. The separate original colour-mask texture is
    # retained for recolouring; the final PNG supplies the true silhouette.
    weight=source[:,:,3:4].astype(np.float32)/255
    colour=np.array([0,0,1],dtype=np.float32)
    shaded=rgb*(weight+(1-weight)*colour)
    shaded=np.divide(shaded, np.maximum(alpha[:,:,None]/255,1/255))
    result=np.empty_like(source)
    result[:,:,:3]=np.clip(np.rint(shaded),0,255).astype(np.uint8)
    result[:,:,3]=np.rint(alpha).astype(np.uint8)
    result[alpha==0,:3]=0
    return result


def main():
    source=ROOT/'public/assets/tech-tree/portraits-rgba'
    output=ROOT/'public/assets/tech-tree/portraits-png';output.mkdir(parents=True,exist_ok=True)
    report=[]
    outlines=json.loads((ROOT/'config/tech-tree-portrait-mattes.json').read_text())
    for path in sorted(source.glob('*.rgba'),key=lambda p:int(p.stem)):
        original=np.frombuffer(path.read_bytes(),dtype=np.uint8).reshape((256,256,4))
        # Icon 523 has one reviewed 106-pixel triangle floating beside its
        # spear. Its larger threshold is limited to this asset.
        limit=128 if path.stem=='523' else 20
        result=cutout(original,outlines.get(path.stem),limit,True)
        Image.fromarray(result).save(output/f'{path.stem}.png',optimize=True)
        report.append({'id':int(path.stem),'transparent':int((result[:,:,3]==0).sum()),'opaque':int((result[:,:,3]==255).sum())})
    qa=ROOT/'.cache/qa';qa.mkdir(parents=True,exist_ok=True)
    (qa/'transparent-portraits-report.json').write_text(json.dumps(report,indent=2))
    print(f'Built {len(report)} transparent PNG portraits')


if __name__=='__main__':main()
