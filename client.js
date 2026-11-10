window.__ModuleLoader__.load({
  id: '@local/dsh-tg-bot',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;

    const NS = 'dsh-tg-bot';
    const STATE_URL = '/dsh-tg-bot/v1/state';
    const ACTION_URL = '/dsh-tg-bot/v1/action';
    const POLL_MS = 5000;

    const EN = {
      nav: 'Telegram Bot',
      title: 'Telegram Bot',
      intro: 'Connect a Telegram bot. Only private chats are supported in this version: a user sends the pairing command to the bot, you approve the request below, and the user joins the whitelist.',
      connection: 'Connection',
      statusIdle: 'Not connected — no bot token saved.',
      statusConnecting: 'Connecting…',
      statusPolling: 'Connected — receiving private messages.',
      statusError: 'Connection error: {msg}',
      bot: 'Bot: {name}',
      tokenLabel: 'Bot token',
      tokenPlaceholder: 'Paste the bot token from @BotFather',
      save: 'Save & connect',
      disconnect: 'Disconnect',
      tokenHint: 'The token is stored as a credential and is never written into configuration.',
      pending: 'Pairing requests',
      pendingEmpty: 'No pending pairing requests.',
      whitelist: 'Whitelist',
      whitelistEmpty: 'No approved users yet.',
      activity: 'Recent activity',
      activityEmpty: 'No messages recorded yet.',
      approve: 'Approve',
      reject: 'Reject',
      revoke: 'Revoke',
      requestedAt: 'Requested {time}',
      approvedAt: 'Approved {time}',
      authError: 'Not authenticated with the current web session.',
      loadError: 'Could not load bot state from the host.',
      actionError: 'Action failed: {msg}',
      pairingHint: 'Ask the user to send {command} to the bot to start pairing.',
    };
    const ZH = {
      nav: 'Telegram 机器人',
      title: 'Telegram 机器人',
      intro: '连接 Telegram Bot。当前版本仅支持私聊：用户向机器人发送配对命令，你在下方批准后，对方记入白名单。',
      connection: '连接',
      statusIdle: '未连接 —— 尚未保存 bot token。',
      statusConnecting: '连接中…',
      statusPolling: '已连接 —— 正在接收私聊消息。',
      statusError: '连接出错：{msg}',
      bot: '机器人：{name}',
      tokenLabel: 'Bot token',
      tokenPlaceholder: '粘贴 @BotFather 提供的 bot token',
      save: '保存并连接',
      disconnect: '断开连接',
      tokenHint: 'token 以凭据形式保存，不会写入配置。',
      pending: '配对请求',
      pendingEmpty: '当前没有待批准的配对请求。',
      whitelist: '白名单',
      whitelistEmpty: '白名单为空。',
      activity: '最近消息',
      activityEmpty: '还没有记录任何消息。',
      approve: '批准',
      reject: '拒绝',
      revoke: '移除',
      requestedAt: '请求于 {time}',
      approvedAt: '批准于 {time}',
      authError: '当前浏览器会话未登录。',
      loadError: '无法从宿主读取机器人状态。',
      actionError: '操作失败：{msg}',
      pairingHint: '让用户向机器人发送 {command} 发起配对。',
    };

    const CSS = [
      '.dsh-tg-bot-root{display:flex;flex-direction:column;gap:14px;max-width:760px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.dsh-tg-bot-title{margin:0;font-size:18px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsh-tg-bot-intro{margin:0;color:var(--dsw-alias-label-secondary)}',
      '.dsh-tg-bot-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}',
      '.dsh-tg-bot-cardTitle{margin:0;font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px}',
      '.dsh-tg-bot-statusRow{display:flex;align-items:center;gap:8px}',
      '.dsh-tg-bot-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}',
      '.dsh-tg-bot-dot-ok{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none}',
      '.dsh-tg-bot-dot-err{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-error-primary);flex:none}',
      '.dsh-tg-bot-dot-warn{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);flex:none}',
      '.dsh-tg-bot-tokenForm{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.dsh-tg-bot-tokenLabel{color:var(--dsw-alias-label-secondary)}',
      '.dsh-tg-bot-tokenInput{flex:1;min-width:220px;padding:5px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.dsh-tg-bot-btn{padding:5px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:13px}',
      '.dsh-tg-bot-btn:disabled{opacity:.55;cursor:default}',
      '.dsh-tg-bot-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}',
      '.dsh-tg-bot-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.dsh-tg-bot-row{display:flex;gap:12px;align-items:center;justify-content:space-between;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-tg-bot-rowMain{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.dsh-tg-bot-rowTitle{font-weight:600}',
      '.dsh-tg-bot-rowActions{display:flex;gap:8px;flex:none}',
      '.dsh-tg-bot-muted{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dsh-tg-bot-empty{margin:0;color:var(--dsw-alias-label-secondary)}',
      '.dsh-tg-bot-error{margin:0;color:var(--dsw-alias-state-error-primary)}',
      '.dsh-tg-bot-badge{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:0 6px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-tg-bot-activityRow{display:flex;gap:10px;align-items:baseline;border-bottom:1px solid var(--dsw-alias-border-l1);padding:6px 0}',
      '.dsh-tg-bot-activityText{min-width:0;word-break:break-word}',
    ].join('\n');

    function fmtTime(ts) {
      return new Date(ts).toLocaleString();
    }

    function displayName(record) {
      const name = [record.firstName, record.lastName].filter((part) => part !== '').join(' ');
      if (name !== '') return name;
      return record.username !== '' ? '@' + record.username : '…';
    }

    function loadState() {
      return fetch(STATE_URL, { headers: { accept: 'application/json' } }).then(async (response) => {
        if (response.status === 401 || response.status === 403) {
          const error = new Error('auth');
          error.auth = true;
          throw error;
        }
        let data = null;
        try {
          data = await response.json();
        } catch {
          data = null;
        }
        if (!response.ok || data === null || data.ok !== true) {
          throw new Error(data !== null && data.error ? data.error : String(response.status));
        }
        return data;
      });
    }

    // Assigned in apply before the section can render; read at render time.
    let translate = null;

    function Section() {
      const [snapshot, setSnapshot] = useState(null);
      const [loadError, setLoadError] = useState(null);
      const [actionError, setActionError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [tokenDraft, setTokenDraft] = useState('');

      useEffect(() => {
        let alive = true;
        let timer = null;
        const refresh = async () => {
          try {
            const data = await loadState();
            if (alive) {
              setSnapshot(data);
              setLoadError(null);
            }
          } catch (error) {
            if (alive) setLoadError(translate('loadError'));
          }
        };
        refresh();
        timer = setInterval(refresh, POLL_MS);
        return () => {
          alive = false;
          if (timer !== null) clearInterval(timer);
        };
      }, []);

      const runAction = async (payload) => {
        setBusy(true);
        setActionError(null);
        try {
          const response = await fetch(ACTION_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          let data = null;
          try {
            data = await response.json();
          } catch {
            data = null;
          }
          if (!response.ok || data === null || data.ok !== true) {
            throw new Error(data !== null && data.error ? data.error : String(response.status));
          }
          const fresh = await loadState();
          setSnapshot(fresh);
          setLoadError(null);
        } catch (error) {
          setActionError(error !== null && error !== undefined && error.auth === true
            ? translate('authError')
            : translate('actionError', { msg: error !== null && error !== undefined ? error.message : String(error) }));
        } finally {
          setBusy(false);
        }
      };

      const s = snapshot;
      const status = s === null ? 'idle' : s.status;
      const dotClass = status === 'polling'
        ? 'dsh-tg-bot-dot-ok'
        : status === 'error'
          ? 'dsh-tg-bot-dot-err'
          : status === 'connecting'
            ? 'dsh-tg-bot-dot-warn'
            : '';
      let statusText;
      if (status === 'polling') statusText = translate('statusPolling');
      else if (status === 'connecting') statusText = translate('statusConnecting');
      else if (status === 'error') statusText = translate('statusError', { msg: s.statusError !== null && s.statusError !== '' ? s.statusError : '?' });
      else statusText = s === null ? translate('statusConnecting') : translate('statusIdle');
      let botName = null;
      if (s !== null && s.bot !== null) {
        botName = s.bot.username !== '' ? '@' + s.bot.username : (s.bot.firstName !== '' ? s.bot.firstName : s.bot.id);
      }

      const statusRow = h('div', { className: 'dsh-tg-bot-statusRow' },
        h('span', { className: 'dsh-tg-bot-dot' + (dotClass !== '' ? ' ' + dotClass : ''), 'aria-hidden': true }),
        h('span', null, statusText));

      const botLine = botName !== null
        ? h('div', { className: 'dsh-tg-bot-muted' }, translate('bot', { name: botName }))
        : null;
      const connectionErrorLine = s !== null && status === 'error' && s.statusError !== null && s.statusError !== ''
        ? h('div', { className: 'dsh-tg-bot-error' }, s.statusError)
        : null;

      const disconnectButton = s !== null && s.configured
        ? h('button', {
          className: 'dsh-tg-bot-btn dsh-tg-bot-btn-danger',
          type: 'button',
          disabled: busy,
          onClick: () => {
            setTokenDraft('');
            runAction({ action: 'removeToken' });
          },
        }, translate('disconnect'))
        : null;

      const tokenForm = h('form', {
        className: 'dsh-tg-bot-tokenForm',
        onSubmit: (event) => {
          event.preventDefault();
          runAction({ action: 'saveToken', token: tokenDraft });
        },
      },
        h('label', { className: 'dsh-tg-bot-tokenLabel', htmlFor: 'dsh-tg-bot-token-input' }, translate('tokenLabel')),
        h('input', {
          id: 'dsh-tg-bot-token-input',
          className: 'dsh-tg-bot-tokenInput',
          type: 'password',
          autoComplete: 'off',
          value: tokenDraft,
          placeholder: translate('tokenPlaceholder'),
          onChange: (event) => setTokenDraft(event.target.value),
        }),
        h('button', {
          className: 'dsh-tg-bot-btn',
          type: 'submit',
          disabled: busy || tokenDraft.trim() === '',
        }, translate('save')),
        disconnectButton);

      const connectionCard = h('section', { className: 'dsh-tg-bot-card' },
        h('h3', { className: 'dsh-tg-bot-cardTitle' }, translate('connection')),
        statusRow,
        botLine,
        connectionErrorLine,
        tokenForm,
        h('p', { className: 'dsh-tg-bot-muted' }, translate('tokenHint')));

      const pendingRows = [];
      if (s === null) {
        pendingRows.push(h('p', { className: 'dsh-tg-bot-empty', key: 'loading' }, translate('statusConnecting')));
      } else if (s.pending.length === 0) {
        pendingRows.push(h('p', { className: 'dsh-tg-bot-empty', key: 'empty' }, translate('pendingEmpty')));
      } else {
        for (const record of s.pending) {
          const main = h('div', { className: 'dsh-tg-bot-rowMain' },
            h('div', { className: 'dsh-tg-bot-rowTitle' },
              displayName(record),
              record.username !== '' ? h('span', { className: 'dsh-tg-bot-muted' }, ' @' + record.username) : null),
            h('div', { className: 'dsh-tg-bot-muted' }, 'id ' + record.userId),
            h('div', { className: 'dsh-tg-bot-muted' }, translate('requestedAt', { time: fmtTime(record.requestedAt) })),
            record.lastText !== '' ? h('div', { className: 'dsh-tg-bot-muted' }, '“' + record.lastText + '”') : null);
          const actions = h('div', { className: 'dsh-tg-bot-rowActions' },
            h('button', {
              className: 'dsh-tg-bot-btn dsh-tg-bot-btn-primary',
              disabled: busy,
              onClick: () => runAction({ action: 'approve', id: record.userId }),
            }, translate('approve')),
            h('button', {
              className: 'dsh-tg-bot-btn',
              disabled: busy,
              onClick: () => runAction({ action: 'reject', id: record.userId }),
            }, translate('reject')));
          pendingRows.push(h('div', { className: 'dsh-tg-bot-row', key: record.userId }, main, actions));
        }
      }
      const pendingBadge = s !== null && s.pending.length > 0
        ? h('span', { className: 'dsh-tg-bot-badge' }, String(s.pending.length))
        : null;
      const pendingCard = h('section', { className: 'dsh-tg-bot-card' },
        h('h3', { className: 'dsh-tg-bot-cardTitle' }, translate('pending'), pendingBadge),
        pendingRows);

      const whitelistRows = [];
      if (s === null) {
        whitelistRows.push(h('p', { className: 'dsh-tg-bot-empty', key: 'loading' }, translate('statusConnecting')));
      } else if (s.whitelist.length === 0) {
        whitelistRows.push(h('p', { className: 'dsh-tg-bot-empty', key: 'empty' }, translate('whitelistEmpty')));
      } else {
        for (const record of s.whitelist) {
          const main = h('div', { className: 'dsh-tg-bot-rowMain' },
            h('div', { className: 'dsh-tg-bot-rowTitle' },
              displayName(record),
              record.username !== '' ? h('span', { className: 'dsh-tg-bot-muted' }, ' @' + record.username) : null),
            h('div', { className: 'dsh-tg-bot-muted' }, 'id ' + record.userId),
            h('div', { className: 'dsh-tg-bot-muted' }, translate('approvedAt', { time: fmtTime(record.approvedAt) })));
          const actions = h('div', { className: 'dsh-tg-bot-rowActions' },
            h('button', {
              className: 'dsh-tg-bot-btn dsh-tg-bot-btn-danger',
              disabled: busy,
              onClick: () => runAction({ action: 'revoke', id: record.userId }),
            }, translate('revoke')));
          whitelistRows.push(h('div', { className: 'dsh-tg-bot-row', key: record.userId }, main, actions));
        }
      }
      const pairingHint = s !== null
        ? h('p', { className: 'dsh-tg-bot-muted' }, translate('pairingHint', { command: s.pairingCommand }))
        : null;
      const whitelistCard = h('section', { className: 'dsh-tg-bot-card' },
        h('h3', { className: 'dsh-tg-bot-cardTitle' }, translate('whitelist')),
        whitelistRows,
        pairingHint);

      const activityRows = [];
      if (s === null) {
        activityRows.push(h('p', { className: 'dsh-tg-bot-empty', key: 'loading' }, translate('statusConnecting')));
      } else if (s.activity.length === 0) {
        activityRows.push(h('p', { className: 'dsh-tg-bot-empty', key: 'empty' }, translate('activityEmpty')));
      } else {
        for (const record of s.activity) {
          activityRows.push(h('div', { className: 'dsh-tg-bot-activityRow', key: record.msgId },
            h('span', { className: 'dsh-tg-bot-muted' }, fmtTime(record.ts)),
            h('span', { className: 'dsh-tg-bot-activityText' },
              (record.username !== '' ? record.username : record.userId) + ': ' + record.text)));
        }
      }
      const activityCard = h('section', { className: 'dsh-tg-bot-card' },
        h('h3', { className: 'dsh-tg-bot-cardTitle' }, translate('activity')),
        activityRows);

      const errorLines = [];
      if (loadError !== null) errorLines.push(h('div', { className: 'dsh-tg-bot-error' }, loadError));
      if (actionError !== null) errorLines.push(h('div', { className: 'dsh-tg-bot-error' }, actionError));

      return h('div', { className: 'dsh-tg-bot-root' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h('h2', { className: 'dsh-tg-bot-title' }, translate('title')),
        h('p', { className: 'dsh-tg-bot-intro' }, translate('intro')),
        errorLines,
        connectionCard,
        pendingCard,
        whitelistCard,
        activityCard);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        translate = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'dsh-tg-bot: locale');
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'telegram-bot',
          order: 25,
          label: () => translate('nav'),
        }, Section));
      },
    };
  },
});
