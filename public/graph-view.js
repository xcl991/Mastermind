const colors = { note: '#a69af5', code: '#71b8d2', tag: '#80c5aa', imported: '#e6b57c', missing: '#727787' };
export class GraphView {
  constructor(canvas, onSelect, mini = false) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.onSelect = onSelect; this.mini = mini; this.nodes = []; this.edges = []; this.zoom = 1; this.offset = { x: 0, y: 0 };
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(canvas);
    canvas.addEventListener('wheel', e => { e.preventDefault(); this.zoom = Math.max(.2, Math.min(5, this.zoom * Math.exp(-e.deltaY * .001))); this.draw(); }, { passive: false });
    canvas.addEventListener('pointerdown', e => { this.drag = { x: e.offsetX, y: e.offsetY, ox: this.offset.x, oy: this.offset.y, moved: false }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', e => {
      if (this.drag) { const dx = e.offsetX - this.drag.x, dy = e.offsetY - this.drag.y; this.offset = { x: this.drag.ox + dx, y: this.drag.oy + dy }; if (Math.abs(dx) + Math.abs(dy) > 5) this.drag.moved = true; }
      this.hover = this.hit(e.offsetX, e.offsetY); canvas.style.cursor = this.hover ? 'pointer' : this.drag ? 'grabbing' : 'grab'; this.draw();
    });
    canvas.addEventListener('pointerup', e => { if (this.drag && !this.drag.moved) { const n = this.hit(e.offsetX, e.offsetY); if (n) this.onSelect(n); } this.drag = null; });
    canvas.addEventListener('pointercancel', () => { this.drag = null; });
    canvas.addEventListener('pointerleave', () => { this.hover = null; this.draw(); });
  }
  resize() { this.width = this.canvas.clientWidth; this.height = this.canvas.clientHeight; const ratio = Math.min(devicePixelRatio || 1, 2); this.canvas.width = this.width * ratio; this.canvas.height = this.height * ratio; this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0); this.draw(); }
  setData(graph, selected) {
    cancelAnimationFrame(this.frame); this.selected = selected;
    const max = this.mini ? 25 : 350;
    this.nodes = graph.nodes.slice(0, max).map((n, i) => { const r = Math.sqrt(i + .5) * (this.mini ? 14 : 24), a = i * 2.399963; return { ...n, x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0 }; });
    const map = new Map(this.nodes.map(n => [n.id, n])); this.edges = graph.links.filter(e => map.has(e.source) && map.has(e.target)).map(e => ({ ...e, a: map.get(e.source), b: map.get(e.target) }));
    this.zoom = 1; this.offset = { x: 0, y: 0 }; this.resize(); this.iteration = 0; this.tick();
  }
  tick() {
    const nodes = this.nodes, strength = this.mini ? 65 : 380;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) { const b = nodes[j], dx = a.x - b.x, dy = a.y - b.y, d2 = Math.max(25, dx * dx + dy * dy), f = strength / d2; a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f; }
    }
    for (const e of this.edges) { const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, d = Math.sqrt(dx * dx + dy * dy) || 1, f = (d - (this.mini ? 42 : 90)) * .007; e.a.vx += dx / d * f; e.a.vy += dy / d * f; e.b.vx -= dx / d * f; e.b.vy -= dy / d * f; }
    for (const n of nodes) { n.vx = (n.vx - n.x * .008) * .6; n.vy = (n.vy - n.y * .008) * .6; n.x += n.vx; n.y += n.vy; }
    this.draw(); if (++this.iteration < 85 && !document.hidden) this.frame = requestAnimationFrame(() => this.tick()); else this.fit();
  }
  fit() { const x = Math.max(80, ...this.nodes.map(n => Math.abs(n.x))), y = Math.max(70, ...this.nodes.map(n => Math.abs(n.y))); this.zoom = Math.min((this.width - 65) / (x * 2), (this.height - 60) / (y * 2), 1.8); this.zoom = Math.max(.1, this.zoom); this.offset = { x: 0, y: 0 }; this.draw(); }
  position(n) { return { x: this.width / 2 + n.x * this.zoom + this.offset.x, y: this.height / 2 + n.y * this.zoom + this.offset.y }; }
  hit(x, y) { return this.nodes.find(n => { const p = this.position(n); return Math.hypot(p.x - x, p.y - y) < 12; }); }
  draw() {
    if (!this.width || !this.height) return; const c = this.ctx; c.clearRect(0, 0, this.width, this.height);
    const active = this.hover?.id ?? this.selected;
    for (const e of this.edges) { const a = this.position(e.a), b = this.position(e.b); c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.strokeStyle = e.source === active || e.target === active ? '#8d80bd88' : '#56567245'; c.lineWidth = this.mini ? .7 : 1; c.stroke(); }
    for (const n of this.nodes) {
      const p = this.position(n), radius = n.id === active ? 6 : this.mini ? 3.5 : Math.min(8, 3 + Math.sqrt(n.degree || 0));
      if (n.id === active) { c.beginPath(); c.arc(p.x, p.y, radius + 7, 0, Math.PI * 2); c.fillStyle = '#a69af51c'; c.fill(); }
      c.beginPath(); c.arc(p.x, p.y, radius, 0, Math.PI * 2); c.fillStyle = colors[n.type] || colors.note; c.fill();
      if ((!this.mini && this.nodes.length < 60) || n.id === active || (this.mini && (n.id === this.selected))) { c.font = `${this.mini ? 9 : 11}px -apple-system, sans-serif`; c.textAlign = 'center'; c.fillStyle = n.id === active ? '#e0dafa' : '#9295ad'; const label = String(n.label); c.fillText(label.length > 28 ? label.slice(0, 26) + '…' : label, p.x, p.y + radius + 15); }
    }
  }
}
