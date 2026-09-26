// call.js — a live call with Thea.
//
// Audio goes phone <-> OpenAI gpt-live-1 directly over WebRTC (lowest latency). The box
// creates the session (key, her instructions, memory, recent texts stay there) and sits on
// the same session through a sideband: when she needs her memory, tools or real thinking,
// the voice delegates, her own mind on the box does it, and she says the result. The page
// only sees captions and a "working on it" signal.
(function () {
  class Call {
    constructor(ui) { this.ui = ui; this.state = 'idle'; this.working = 0; }

    async start(voice) {
      if (this.state !== 'idle') return;
      this.set('connecting');
      // iOS wants the AudioContext born inside the tap, before any await
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = AC ? new AC() : null;
      try {
        this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch {
        return this.fail('she needs your microphone for a call — allow it and tap again');
      }
      try {
        const pc = this.pc = new RTCPeerConnection();
        this.audio = document.createElement('audio');
        this.audio.autoplay = true; this.audio.setAttribute('playsinline', ''); document.body.appendChild(this.audio);
        pc.ontrack = (e) => { this.audio.srcObject = e.streams[0]; this.meter(e.streams[0]); };
        this.mic.getTracks().forEach((t) => pc.addTrack(t, this.mic));
        const dc = this.dc = pc.createDataChannel('oai-events');
        dc.onmessage = (m) => { try { this.onEvent(JSON.parse(m.data)); } catch {} };
        pc.onconnectionstatechange = () => {
          const s = pc.connectionState;
          if ((s === 'failed' || s === 'closed') && this.state !== 'idle') this.end(s === 'failed' ? 'the line dropped' : null);
        };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const r = await fetch('/api/live/session', {
          method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sdp: offer.sdp, voice }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.sdp) return this.fail(j.error || 'could not reach her');
        this.id = j.id;
        await pc.setRemoteDescription({ type: 'answer', sdp: j.sdp });
        this.started = Date.now();
        this.set('live');
      } catch (e) {
        this.fail(e.message || 'call failed');
      }
    }

    onEvent(ev) {
      switch (ev.type) {
        case 'session.input_transcript.delta': this.ui.caption('him', ev.delta); break;
        case 'session.output_transcript.delta': this.ui.caption('her', ev.delta); break;
        case 'session.delegation.created': this.working++; this.ui.working(true); break;
        case 'session.commentary.appended': this.working = Math.max(0, this.working - 1); if (!this.working) this.ui.working(false); break;
        case 'session.closed': this.end(); break;
        case 'error': this.ui.note((ev.error && ev.error.message) || 'something went wrong'); break;
      }
    }

    meter(stream) {
      if (!this.ctx) return;
      try {
        this.ctx.resume();
        const src = this.ctx.createMediaStreamSource(stream), an = this.ctx.createAnalyser();
        an.fftSize = 512; src.connect(an);
        const buf = new Uint8Array(an.fftSize);
        const tick = () => {
          if (this.state === 'idle') return;
          an.getByteTimeDomainData(buf);
          let sum = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
          const rms = Math.sqrt(sum / buf.length);
          this.ui.level(Math.min(1, rms * 4.5));
          requestAnimationFrame(tick);
        };
        tick();
      } catch {}
    }

    mute(on) { (this.mic ? this.mic.getAudioTracks() : []).forEach((t) => { t.enabled = !on; }); this.muted = on; }

    seconds() { return this.started ? Math.round((Date.now() - this.started) / 1000) : 0; }

    set(s) { this.state = s; this.ui.state(s); }

    fail(msg) { const was = this.state; this.teardown(); this.set('idle'); this.ui.ended(msg, 0, was); }

    end(reason) {
      if (this.state === 'idle') return;
      const secs = this.seconds();
      try { this.dc && this.dc.readyState === 'open' && this.dc.send(JSON.stringify({ type: 'session.close' })); } catch {}
      if (this.id) fetch('/api/live/hangup', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: this.id }) }).catch(() => {});
      this.teardown();
      this.set('idle');
      this.ui.ended(reason || null, secs);
    }

    teardown() {
      try { this.pc && this.pc.close(); } catch {}
      try { this.mic && this.mic.getTracks().forEach((t) => t.stop()); } catch {}
      try { this.ctx && this.ctx.close(); } catch {}
      try { this.audio && this.audio.remove(); } catch {}
      this.pc = this.dc = this.mic = this.ctx = this.audio = null; this.id = null; this.started = 0; this.working = 0;
      this.ui.level(0); this.ui.working(false);
    }
  }
  window.TheaCall = Call;
})();
