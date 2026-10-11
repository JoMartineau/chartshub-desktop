// Only bounded presentation values cross the existing snapshot channels.
export function applyButtonMotion(element, value) {
  element.dataset.chEconomy = value?.economy === true ? 'on' : 'off';
  if ([1, 3, 5].includes(value?.hoverLift)) element.style.setProperty('--ch-motion-hover-lift', `${value.hoverLift}px`);
  else element.style.removeProperty('--ch-motion-hover-lift');
}
