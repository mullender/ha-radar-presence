// WebGL2 point-cloud layer. All history points are uploaded once; the time
// window, cursor fade and per-point highlight are uniforms / a small flag
// buffer, so scrubbing a 48 h cloud never re-uploads positions.

import { SLOT_COLORS, hexToRgb } from './util.js';

const VS = `#version 300 es
in vec2 a_pos;      // mm, sensor frame
in float a_t;       // seconds since history start
in float a_slot;
in float a_flag;    // 1 = inside highlighted polygon, 2 = excluded
uniform mat3 u_view;      // mm -> clip space
uniform vec2 u_window;    // visible [t0, t1]
uniform float u_cursor;   // replay cursor (s); < 0 disables fading
uniform float u_trail;    // seconds of trail shown behind the cursor
uniform float u_context;  // 1 = keep the rest of the windowed cloud, faded, during replay
uniform float u_size;
uniform int u_colorMode;  // 0 slot, 1 highlight, 2 age
uniform vec3 u_slotColors[6];
out vec4 v_color;
void main() {
  if (a_t < u_window.x || a_t > u_window.y) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); gl_PointSize = 0.0; return; }
  vec3 p = u_view * vec3(a_pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  float alpha = 0.35;
  vec3 c = u_slotColors[int(a_slot) - 1];
  if (u_colorMode == 1) {
    c = a_flag > 1.5 ? vec3(0.55) : (a_flag > 0.5 ? vec3(0.95, 0.35, 0.1) : vec3(0.25, 0.35, 0.55));
    alpha = a_flag > 0.5 ? 0.6 : 0.25;
  } else if (u_colorMode == 2) {
    float k = clamp((a_t - u_window.x) / max(1.0, u_window.y - u_window.x), 0.0, 1.0);
    c = mix(vec3(0.2, 0.4, 0.9), vec3(0.95, 0.3, 0.1), k);
  }
  float size = u_size;
  if (u_cursor >= 0.0) {
    float age = u_cursor - a_t;
    if (age < 0.0 || age > u_trail) {
      if (u_context < 0.5) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); gl_PointSize = 0.0; return; }
      // Context: the rest of the cloud stays visible, faded and desaturated.
      c = mix(c, vec3(0.5), 0.35);
      alpha = u_colorMode == 1 ? alpha * 0.7 : 0.22;
    } else {
      float k = 1.0 - age / u_trail;
      alpha = 0.15 + 0.85 * k;
      size = u_size + 3.0 * k;
    }
  }
  gl_PointSize = size;
  v_color = vec4(c, alpha);
}`;

const FS = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = dot(d, d);
  if (r > 0.25) discard;
  outColor = vec4(v_color.rgb, v_color.a * smoothstep(0.25, 0.12, r));
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

export class PointLayer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: true });
    this.gl = gl;
    if (!gl) return;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.loc = Object.fromEntries(
      ['u_view', 'u_window', 'u_cursor', 'u_trail', 'u_context', 'u_size', 'u_colorMode', 'u_slotColors'].map(n => [n, gl.getUniformLocation(prog, n)]),
    );
    this.vao = gl.createVertexArray();
    this.buffers = {};
    this.count = 0;
    this.slotColors = new Float32Array(SLOT_COLORS.flatMap(h => hexToRgb(h).map(v => v / 255)));
  }

  get ok() {
    return !!this.gl;
  }

  _attr(name, data, size) {
    const gl = this.gl;
    const loc = gl.getAttribLocation(this.prog, name);
    if (!this.buffers[name]) this.buffers[name] = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[name]);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }

  /** pts: {pos: Float32Array(2n), t: Float32Array(n), slot: Float32Array(n)} */
  setPoints(pts) {
    if (!this.ok) return;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    this._attr('a_pos', pts.pos, 2);
    this._attr('a_t', pts.t, 1);
    this._attr('a_slot', pts.slot, 1);
    this._attr('a_flag', new Float32Array(pts.t.length), 1);
    gl.bindVertexArray(null);
    this.count = pts.t.length;
  }

  setFlags(flags) {
    if (!this.ok || flags.length !== this.count) return;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    this._attr('a_flag', flags, 1);
    gl.bindVertexArray(null);
  }

  /** view: column-major mat3 (Float32Array 9) mapping mm to clip space. */
  draw({ view, window, cursor = -1, trail = 30, size = 2.5, colorMode = 0, context = true }) {
    if (!this.ok) return;
    const gl = this.gl;
    const dpr = window?.dpr || devicePixelRatio || 1;
    const w = this.canvas.clientWidth * dpr, h = this.canvas.clientHeight * dpr;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.count) return;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.prog);
    gl.uniformMatrix3fv(this.loc.u_view, false, view);
    gl.uniform2f(this.loc.u_window, window.t0, window.t1);
    gl.uniform1f(this.loc.u_cursor, cursor);
    gl.uniform1f(this.loc.u_trail, trail);
    gl.uniform1f(this.loc.u_context, context ? 1 : 0);
    gl.uniform1f(this.loc.u_size, size * (devicePixelRatio || 1));
    gl.uniform1i(this.loc.u_colorMode, colorMode);
    gl.uniform3fv(this.loc.u_slotColors, this.slotColors);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.bindVertexArray(null);
  }
}
