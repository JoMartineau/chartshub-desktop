// Decorative canvas accents only. Geometry, colours and visibility come from
// the validated viewer configuration; there is no input or animation state.
const EXTRA_STYLES = new Set(['plasma', 'crystal', 'synthwave', 'industrial']);

function body(ctx, c) {
  ctx.beginPath();
  if (c.shape === 'cymbal') ctx.ellipse(c.x + c.width * .5, c.y + c.height * .39, c.width * .46, c.height * .29, 0, 0, Math.PI * 2);
  else if (c.shape === 'circle') ctx.ellipse(c.x + c.width / 2, c.y + c.height / 2, c.width / 2, c.height / 2, 0, 0, Math.PI * 2);
  else if (c.shape === 'star') {
    for (let i = 0; i < 10; i++) {
      const angle = -Math.PI / 2 + i * Math.PI / 5, radius = i % 2 ? .45 : 1;
      const x = c.x + c.width / 2 + Math.cos(angle) * c.width / 2 * radius;
      const y = c.y + c.height / 2 + Math.sin(angle) * c.height / 2 * radius;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  } else if (c.shape === 'diamond') {
    ctx.moveTo(c.x + c.width / 2, c.y); ctx.lineTo(c.x + c.width, c.y + c.height / 2);
    ctx.lineTo(c.x + c.width / 2, c.y + c.height); ctx.lineTo(c.x, c.y + c.height / 2); ctx.closePath();
  } else ctx.roundRect(c.x, c.y, c.width, c.height, Math.min(12, c.height / 4));
}

const tint = (hex, white) => '#' + [0, 2, 4].map(index => {
  const channel = parseInt(hex.slice(index + 1, index + 3), 16);
  return Math.round(channel + (255 - channel) * white).toString(16).padStart(2, '0');
}).join('');

export function paintStyleAccent(ctx, c, down, config) {
  const style = config.renderStyle;
  if (!EXTRA_STYLES.has(style) || c.visible === false) return false;
  const cymbal = c.shape === 'cymbal';
  const cx = c.x + c.width / 2, cy = c.y + c.height * (cymbal ? .39 : .5);
  const rx = c.width * (cymbal ? .46 : .5), ry = c.height * (cymbal ? .29 : .5);
  const small = Math.max(1, Math.min(rx, ry)), light = tint(c.color, .48);
  ctx.save();
  body(ctx, c); ctx.clip();
  // These accents are drawn after the base and its label. Keep the label and
  // the raised cymbal bell clear instead of washing them with an opaque fill.
  ctx.beginPath(); ctx.rect(c.x - 1, c.y - 1, c.width + 2, c.height + 2);
  if (cymbal) ctx.ellipse(cx, cy - c.height * .04, c.width * .15, c.height * .17, 0, 0, Math.PI * 2);
  else if (config.showNames) ctx.rect(c.x, cy - (c.fontSize + 5) / 2, c.width, c.fontSize + 5);
  ctx.clip('evenodd');
  ctx.translate(cx, cy); ctx.scale(rx, ry);
  ctx.lineWidth = 1 / small; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = c.color; ctx.shadowColor = c.color;
  const bloom = Math.max(0, Math.min(80, config.bloom));

  if (style === 'plasma') {
    ctx.shadowBlur = bloom * (down ? .3 : .1);
    for (let arc = 0; arc < 3; arc++) {
      ctx.save(); ctx.rotate(arc * Math.PI * 2 / 3);
      ctx.globalAlpha = down ? .7 : .36; ctx.strokeStyle = arc === 1 ? light : c.color;
      ctx.lineWidth = (down ? 1.6 : 1) / small;
      ctx.beginPath(); ctx.moveTo(-.96, -.14);
      ctx.bezierCurveTo(-.62, -.94, .58, -.9, .83, -.23);
      ctx.bezierCurveTo(1.02, .32, .3, .76, -.18, .51); ctx.stroke();
      ctx.restore();
    }
  } else if (style === 'crystal') {
    // Six clipped facets keep circles round and stars star-shaped while adding
    // visible angular reflections to the existing translucent glass material.
    for (let face = 0; face < 6; face++) {
      const a = -Math.PI / 2 + face * Math.PI / 3, b = a + Math.PI / 3;
      ctx.beginPath(); ctx.moveTo(-.12, .13);
      ctx.lineTo(Math.cos(a) * 1.08, Math.sin(a) * 1.08);
      ctx.lineTo(Math.cos(b) * 1.08, Math.sin(b) * 1.08); ctx.closePath();
      ctx.globalAlpha = (down ? .32 : .19) * (face % 2 ? .55 : 1);
      ctx.fillStyle = face % 2 ? light : c.color; ctx.fill();
      ctx.globalAlpha = down ? .6 : .34; ctx.strokeStyle = light; ctx.lineWidth = .65 / small; ctx.stroke();
    }
  } else if (style === 'synthwave') {
    ctx.shadowBlur = bloom * (down ? .18 : .06);
    ctx.globalAlpha = down ? .85 : .48;
    ctx.strokeStyle = light; ctx.lineWidth = 1.15 / small;
    ctx.beginPath(); ctx.ellipse(0, -.4, .34, .3, 0, Math.PI, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = c.color; ctx.lineWidth = .85 / small;
    for (const y of [-.58, -.43, -.28, .5, .69, .9]) {
      ctx.beginPath(); ctx.moveTo(-1, y); ctx.lineTo(1, y); ctx.stroke();
    }
    // A bounded perspective fan distinguishes this from hologram scanlines.
    for (const end of [-1, -.5, 0, .5, 1]) {
      ctx.beginPath(); ctx.moveTo(end * .08, .34); ctx.lineTo(end, 1); ctx.stroke();
    }
  } else {
    // Rivets and panel seams sit inside the control so they do not enlarge its
    // hitbox or cover neighbouring controls in a compact arrangement.
    ctx.shadowBlur = 0; ctx.globalAlpha = down ? .75 : .48;
    ctx.strokeStyle = c.palette?.idle || '#101d30'; ctx.lineWidth = 2.8 / small;
    ctx.beginPath(); ctx.ellipse(0, 0, .8, .8, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = light; ctx.lineWidth = .75 / small;
    for (let bolt = 0; bolt < 4; bolt++) {
      const angle = Math.PI / 4 + bolt * Math.PI / 2, x = Math.cos(angle) * .76, y = Math.sin(angle) * .76;
      const radius = Math.max(.7, Math.min(2.8, small * .065));
      ctx.beginPath(); ctx.ellipse(x, y, radius / rx, radius / ry, 0, 0, Math.PI * 2);
      ctx.fillStyle = tint(c.palette?.idle || '#101d30', .48); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - radius * .65 / rx, y); ctx.lineTo(x + radius * .65 / rx, y); ctx.stroke();
    }
    ctx.globalAlpha = down ? .52 : .28; ctx.strokeStyle = c.color;
    for (const y of [-.72, .72]) { ctx.beginPath(); ctx.moveTo(-.55, y); ctx.lineTo(.55, y); ctx.stroke(); }
  }
  ctx.restore();
  return true;
}
