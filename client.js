window.__ModuleLoader__.load({
  id: 'dsh-mihomo',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    async function api(path, init) {
      const res = await fetch(path, {
        headers: { 'content-type': 'application/json' },
        ...init,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    }

    function ProxyChip() {
      const [state, setState] = useState(null);
      const [busy, setBusy] = useState(false);
      const sourceRef = useRef(null);
      const retryRef = useRef(null);

      // Push updates: one frame on connect, then only when the host sees a
      // change. Reconnect after 3 s; the initial GET below covers first paint.
      useEffect(() => {
        let disposed = false;
        const apply = (next) => { if (next) setState(next); };

        function schedule() {
          if (disposed || retryRef.current) return;
          retryRef.current = setTimeout(() => {
            retryRef.current = null;
            connect();
          }, 3000);
        }

        function connect() {
          if (disposed || sourceRef.current) return;
          let source;
          try {
            source = new EventSource('/dsh-mihomo/state/stream');
          } catch {
            schedule();
            return;
          }
          sourceRef.current = source;
          source.onmessage = (event) => {
            try { apply(JSON.parse(event.data)); } catch { /* ignore malformed frame */ }
          };
          source.onopen = () => {
            if (retryRef.current) {
              clearTimeout(retryRef.current);
              retryRef.current = null;
            }
          };
          source.onerror = () => {
            source.close();
            if (sourceRef.current === source) sourceRef.current = null;
            schedule();
          };
        }

        connect();
        return () => {
          disposed = true;
          if (retryRef.current) clearTimeout(retryRef.current);
          retryRef.current = null;
          if (sourceRef.current) sourceRef.current.close();
          sourceRef.current = null;
        };
      }, []);

      const refresh = useCallback(async () => {
        try {
          const body = await api('/dsh-mihomo/state');
          setState(body.state);
        } catch (err) {
          setState({ status: 'error', error: String(err && err.message ? err.message : err) });
        }
      }, []);

      useEffect(() => { void refresh(); }, [refresh]);

      const toggle = async () => {
        if (busy) return;
        setBusy(true);
        try {
          const running = state && state.status === 'running';
          const body = await api('/dsh-mihomo/action', {
            method: 'POST',
            body: JSON.stringify({ action: running ? 'stop' : 'start' }),
          });
          // The action already returns the new state; no extra round trip.
          if (body && body.state) setState(body.state);
          else await refresh();
        } catch (err) {
          setState({ status: 'error', error: String(err && err.message ? err.message : err) });
        } finally {
          setBusy(false);
        }
      };

      const status = state ? state.status : 'loading';
      const dot = status === 'error'
        ? 'rgba(190,90,90,0.85)'
        : status === 'running' ? 'rgba(110,145,110,0.95)' : 'rgba(128,128,128,0.35)';
      const label = status === 'running' ? '代理开' : status === 'error' ? '代理异常' : status === 'starting' ? '启动中' : '代理关';
      const node = status === 'running' && state && state.exitNode ? state.exitNode : '';
      const port = state && state.port ? state.port : '';

      return h('button', {
        type: 'button',
        onClick: toggle,
        title: status === 'error' && state && state.error
          ? state.error
          : node ? `${label} · 127.0.0.1:${port} · ${node}` : `${label} · 点击切换`,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          margin: '0 6px',
          padding: '2px 10px',
          height: '24px',
          borderRadius: '999px',
          border: '1px solid rgba(128,128,128,0.28)',
          background: 'transparent',
          color: 'rgba(138,138,138,0.95)',
          font: 'inherit',
          fontSize: '12px',
          opacity: busy ? 0.45 : 1,
          cursor: busy ? 'progress' : 'pointer',
          whiteSpace: 'nowrap',
        },
      },
      h('span', {
        style: { width: '7px', height: '7px', borderRadius: '50%', background: dot, flex: 'none' },
      }),
      h('span', null, label),
      node ? h('span', { style: { opacity: 0.8 } }, `· ${node}`) : null);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'dsh-mihomo',
          order: 5,
        }, ProxyChip));
      },
    };
  },
});
