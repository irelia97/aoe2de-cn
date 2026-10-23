// Front-facing versions of the in-game building-flag symbols.
// Geometry stays in screen coordinates, independent of map projection.
const silhouettes = {
  castle: 'M2 23V10H5V7H8V10H10V5L12 2L14 5V10H16V7H19V10H22V23H15V18Q15 14 12 14Q9 14 9 18V23Z',
  tower: 'M5 23V5H8V8H10V4H14V8H16V5H19V23H14V18Q14 15 12 15Q10 15 10 18V23Z',
  barracks: 'M1 4Q4 9 13 9L19 2L18 10L14 14Q5 13 1 4Z M2 20Q10 19 16 12L19 14Q11 23 2 20Z M15 10L21 16L23 14L17 8Z M5 16L10 22L8 24L3 18Z',
  archery: 'M5 3Q22 12 5 21L7 17Q16 12 7 7Z M5 3L3 1L4 6L7 7Z M5 21L3 23L4 18L7 17Z M4 11H19V8L23 12L19 16V13H4Z',
  stable: 'M4 23L5 12L8 7L10 2L13 5L18 5L22 9L20 13L15 12L14 15L19 19L20 23Z',
  siege: 'M2 17L8 11L5 8L1 7L3 4L8 6L13 12L18 17L16 20L10 14L5 20Z M12 1H15V17H12Z M14 5L23 9L21 12L14 9Z M6 18H20V21H6Z',
  townCenter: 'M2 17Q2 10 7 10Q10 10 11 13Q12 9 17 9Q22 9 22 16V18Q16 16 13 20L9 23L3 23Z',
  monastery: 'M3 21L6 17L8 7L11 1L12 2L12 13L10 18L9 23Z M21 21L18 17L16 7L13 1L12 2L12 13L14 18L15 23Z',
  dock: 'M11 8H13V17Q16 17 19 13L16 14L17 10L23 10L22 17L20 15Q16 23 12 23Q8 23 4 15L2 17L1 10L7 10L8 14L5 13Q8 17 11 17Z',
};

export function drawBuildingGlyph(ctx, id, x, y, color) {
  ctx.save();
  ctx.translate(Math.round(x) - 12, Math.round(y) - 12);
  ctx.fillStyle = color;
  ctx.strokeStyle = '#18251a';
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  const shape = path => { const p = new Path2D(path); ctx.fill(p); ctx.stroke(p); };
  const line = path => ctx.stroke(new Path2D(path));
  const ellipse = (x,y,rx,ry) => { ctx.beginPath(); ctx.ellipse(x,y,rx,ry,0,0,Math.PI*2); ctx.fill(); ctx.stroke(); };
  if ([82,1251].includes(id)) {
    shape(silhouettes.castle);
    line('M12 2V0M12 0H18L15 3H12 M4 13V16M7 12V15M17 12V15M20 13V16');
  } else if ([79,234,235,1665,236].includes(id)) {
    shape(silhouettes.tower);
    line('M8 11V14M16 11V14');
    if (id === 236) shape('M13 10H23V13H13Z');
  } else if ([109,71,621].includes(id)) {
    ellipse(6,5,3.2,3.7); ellipse(17,4,3.2,3.7);
    shape(silhouettes.townCenter);
    ellipse(12,11,3.2,3.7);
    line('M4 21Q7 17 10 17M14 20Q18 17 21 18');
  } else if (id === 12) {
    shape(silhouettes.barracks);
  } else if (id === 87) {
    shape(silhouettes.archery);
    ctx.lineWidth = .8; line('M5 3L5 21');
  } else if (id === 101) {
    shape(silhouettes.stable);
    line('M14 8H16M7 10L11 6');
  } else if (id === 49) {
    shape(silhouettes.siege);
    ellipse(5,20,3,3); ellipse(19,20,3,3);
    line('M5 18V22M3 20H7M19 18V22M17 20H21');
  } else if (id === 45) {
    shape(silhouettes.dock);
    ellipse(12,4,3,3); ctx.fillStyle = '#18251a';
    ctx.beginPath(); ctx.arc(12,4,1.1,0,Math.PI*2); ctx.fill();
    ctx.fillStyle = color; shape('M7 7H17V9H7Z');
  } else if ([104,1806].includes(id)) {
    shape(silhouettes.monastery);
    line('M12 3V17M8 10L7 17M16 10L17 17M4 20L9 22M20 20L15 22');
  }
  ctx.restore();
}
