/* Tom da Voz — motor de detecção (nota e tonalidade) */
(function (root) {
  const SHARP = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const FLAT  = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
  const SOLF_S = ['Dó','Dó#','Ré','Ré#','Mi','Fá','Fá#','Sol','Sol#','Lá','Lá#','Si'];
  const SOLF_B = ['Dó','Ré♭','Ré','Mi♭','Mi','Fá','Sol♭','Sol','Lá♭','Lá','Si♭','Si'];
  // Grafia usual de cada tom (cifra)
  const KEY_MAJ = ['C','Db','D','Eb','E','F','F#','G','Ab','A','Bb','B'];
  const KEY_MIN = ['Cm','C#m','Dm','Ebm','Em','Fm','F#m','Gm','G#m','Am','Bbm','Bm'];
  const KEY_MAJ_PT = ['Dó','Ré♭','Ré','Mi♭','Mi','Fá','Fá#','Sol','Lá♭','Lá','Si♭','Si'];
  const KEY_MIN_PT = ['Dó','Dó#','Ré','Mi♭','Mi','Fá','Fá#','Sol','Sol#','Lá','Si♭','Si'];

  // Perfis de Krumhansl-Kessler
  const PMAJ = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
  const PMIN = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];

  /* Detecção de frequência fundamental (YIN). Retorna {freq, clarity} ou null. */
  function detectPitch(buf, sr, minF = 65, maxF = 1100, threshold = 0.12) {
    const half = buf.length >> 1;
    const minTau = Math.max(2, Math.floor(sr / maxF));
    const maxTau = Math.min(half - 1, Math.ceil(sr / minF));
    const d = new Float32Array(maxTau + 2);
    for (let t = 1; t <= maxTau + 1; t++) {
      let s = 0;
      for (let i = 0; i < half; i++) { const x = buf[i] - buf[i + t]; s += x * x; }
      d[t] = s;
    }
    d[0] = 1;
    let run = 0;
    for (let t = 1; t <= maxTau + 1; t++) { run += d[t]; d[t] = run ? d[t] * t / run : 1; }
    let tau = -1;
    for (let t = minTau; t <= maxTau; t++) {
      if (d[t] < threshold) {
        while (t + 1 <= maxTau && d[t + 1] < d[t]) t++;
        tau = t; break;
      }
    }
    if (tau < 0) return null;
    const a = d[tau - 1], b = d[tau], c = d[tau + 1];
    const den = a + c - 2 * b;
    const shift = den ? (a - c) / (2 * den) : 0;
    return { freq: sr / (tau + shift), clarity: 1 - b };
  }

  function rms(buf) { let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return Math.sqrt(s / buf.length); }

  const freqToMidi = (f, a4 = 440) => 69 + 12 * Math.log2(f / a4);
  const pc = m => ((Math.round(m) % 12) + 12) % 12;

  function noteInfo(midiFloat, flats = false, a4 = 440) {
    const n = Math.round(midiFloat);
    const p = ((n % 12) + 12) % 12;
    return {
      midi: n, pc: p,
      name: (flats ? FLAT : SHARP)[p],
      solf: (flats ? SOLF_B : SOLF_S)[p],
      octave: Math.floor(n / 12) - 1,
      cents: Math.round((midiFloat - n) * 100),
      target: a4 * Math.pow(2, (n - 69) / 12)
    };
  }

  function pearson(x, y) {
    const n = x.length; let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
    mx /= n; my /= n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
  }

  /* Estima a tonalidade a partir de um histograma de 12 classes de nota. */
  function estimateKey(hist, allowMinor = true) {
    const out = [];
    for (let t = 0; t < 12; t++) {
      const rot = i => hist[(i + t) % 12];
      const h = Array.from({ length: 12 }, (_, i) => rot(i));
      out.push({ tonic: t, minor: false, score: pearson(h, PMAJ) });
      if (allowMinor) out.push({ tonic: t, minor: true, score: pearson(h, PMIN) });
    }
    out.sort((a, b) => b.score - a.score);
    return out.map(k => Object.assign(k, keyName(k.tonic, k.minor)));
  }

  function keyName(tonic, minor) {
    return minor
      ? { chord: KEY_MIN[tonic], pt: KEY_MIN_PT[tonic] + ' menor' }
      : { chord: KEY_MAJ[tonic], pt: KEY_MAJ_PT[tonic] + ' maior' };
  }

  // Tônica maior equivalente (relativa): Em -> G
  const majorEquiv = k => k.minor ? (k.tonic + 3) % 12 : k.tonic;

  /* Diferença em semitons (-6..+6) entre tom cantado e tom do louvor */
  function keyDiff(sung, target) {
    let d = (majorEquiv(sung) - majorEquiv(target) + 12) % 12;
    if (d > 6) d -= 12;
    return d;
  }

  function describeDiff(semi) {
    if (semi === 0) return 'No tom certo';
    const a = Math.abs(semi);
    const tons = { 1: '½ tom', 2: '1 tom', 3: '1 tom e ½', 4: '2 tons', 5: '2 tons e ½', 6: '3 tons' }[a];
    return `${tons} ${semi > 0 ? 'acima' : 'abaixo'}`;
  }

  const api = { SHARP, FLAT, SOLF_S, SOLF_B, KEY_MAJ, KEY_MIN, detectPitch, rms, freqToMidi, pc, noteInfo, estimateKey, keyName, keyDiff, describeDiff };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TomCore = api;
})(this);
