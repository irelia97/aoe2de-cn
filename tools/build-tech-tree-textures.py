"""Losslessly pack original RGB + player-colour mask into cacheable PNG data."""
from pathlib import Path
import numpy as np
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
source=ROOT/'public/assets/tech-tree/portraits-rgba'
target=ROOT/'public/assets/tech-tree/portraits-textures';target.mkdir(parents=True,exist_ok=True)
raw_bytes=packed_bytes=0
for file in source.glob('*.rgba'):
    raw=np.frombuffer(file.read_bytes(),dtype=np.uint8).reshape((256,256,4))
    # Browser decoding must not discard RGB at alpha=0: store both halves opaque.
    packed=np.concatenate([raw[:,:,:3],np.repeat(raw[:,:,3:4],3,axis=2)],axis=1)
    output=target/f'{file.stem}.png'
    Image.fromarray(packed).save(output,optimize=True)
    decoded=np.asarray(Image.open(output))
    restored=np.concatenate([decoded[:,:256,:],decoded[:,256:,0:1]],axis=2)
    assert np.array_equal(restored,raw),file.name
    raw_bytes+=file.stat().st_size;packed_bytes+=output.stat().st_size
print(f'148 lossless textures: {raw_bytes} -> {packed_bytes} bytes ({packed_bytes/raw_bytes:.1%})')
