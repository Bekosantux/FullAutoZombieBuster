// ==UserScript==
// @name         X インプレゾンビ自動ミュート/ブロック（条件1-4）
// @namespace    https://example.local/
// @version      0.1.0
// @description  返信欄（会話タイムライン）で表示名/認証/ホバーカードのプロフィールから判定し、条件1-4を全て満たすアカウントをミュート/ブロックします（条件5は未実装）
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  // ===== 設定 =====
  const ACTION = 'mute'; // 'mute' or 'block'
  const DRY_RUN = true;  // true: クリックしない（ログのみ）
  const SCAN_INTERVAL_MS = 1200;
  const HOVERCARD_TIMEOUT_MS = 1800;
  const KEYWORDS = ['Web3', 'Crypto', 'AI']; // 条件3
  const DEBUG = false;

  // ===== ユーティリティ =====
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ひらがな/カタカナ/漢字が含まれるか（表示名・プロフィール日本語判定用）
  const hasJapanese = (text) => {
    if (!text) return false;
    try {
      return /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text);
    } catch {
      // 古い環境向けフォールバック（ざっくり）
      return /[ぁ-んァ-ン一-龥]/.test(text);
    }
  };

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  const includesAnyKeyword = (text) => {
    const t = (text || '').toLowerCase();
    return KEYWORDS.some((k) => t.includes(String(k).toLowerCase()));
  };

  const log = (...args) => console.log('[imp-zombie]', ...args);
  const dlog = (...args) => { if (DEBUG) console.log('[imp-zombie:debug]', ...args); };

  // ===== X DOMヘルパ =====
  function getConversationRoot() {
    // 会話タイムライン（言語差・UI差があるので複数候補）
    const candidates = [
      'div[aria-label="タイムライン: 会話"]',
      'div[aria-label="Timeline: Conversation"]',
      'section[aria-label="タイムライン: 会話"]',
      'section[aria-label="Timeline: Conversation"]',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    // フォールバック：/status/ 配下なら main を使う
    if (location.pathname.includes('/status/')) return document.querySelector('main') || document.body;
    return null;
  }

  function getTweetArticles(root) {
    return Array.from((root || document).querySelectorAll('article[data-testid="tweet"]'));
  }

  function extractUserNameBlock(article) {
    return article.querySelector('div[data-testid="User-Name"]') || null;
  }

  function extractDisplayName(userNameBlock) {
    // User-Name内の最初のspanが表示名であることが多い
    const span = userNameBlock?.querySelector('span');
    return norm(span?.textContent || '');
  }

  function extractHandle(userNameBlock) {
    // /<handle> へのリンクを探す（/status/ を含まないもの）
    const links = Array.from(userNameBlock?.querySelectorAll('a[href^="/"]') || []);
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      if (!href || href.includes('/status/')) continue;
      // /i/user/<id> のような特殊リンクは除外
      if (href.startsWith('/i/')) continue;
      const handle = href.split('?')[0].split('/').filter(Boolean)[0];
      if (handle) return handle;
    }
    return null;
  }

  function isVerified(userNameBlock) {
    if (!userNameBlock) return false;

    // data-testid
    if (userNameBlock.querySelector('[data-testid^="icon-verified"]')) return true;
    if (userNameBlock.querySelector('[data-testid="icon-verified"]')) return true;

    // aria-label
    const svg = userNameBlock.querySelector('svg[aria-label]');
    if (svg) {
      const label = svg.getAttribute('aria-label') || '';
      if (label.includes('認証済み') || label.toLowerCase().includes('verified')) return true;
    }

    // 他にも混ざるので広めに探索
    const any = userNameBlock.querySelectorAll('svg[aria-label]');
    for (const s of any) {
      const label = s.getAttribute('aria-label') || '';
      if (label.includes('認証済み') || label.toLowerCase().includes('verified')) return true;
    }
    return false;
  }

  function findProfileLink(userNameBlock, handle) {
    if (!userNameBlock || !handle) return null;
    return userNameBlock.querySelector(`a[href="/${CSS.escape(handle)}"]`) || null;
  }

  function findHoverCard() {
    // 現状よくある data-testid
    return (
      document.querySelector('div[data-testid="HoverCard"]') ||
      document.querySelector('div[data-testid="hoverCard"]') ||
      null
    );
  }

  async function readProfileFromHoverCard(profileLinkEl) {
    // ホバーカードはX側仕様変更に弱いので、取れない場合は空で返す
    if (!profileLinkEl) return { bio: '', profileText: '' };

    // hover 発火
    profileLinkEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
    profileLinkEl.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true, view: window }));
    profileLinkEl.focus?.();

    const start = Date.now();
    let card = null;
    while (Date.now() - start < HOVERCARD_TIMEOUT_MS) {
      card = findHoverCard();
      if (card) break;
      await sleep(60);
    }

    let bio = '';
    let location = '';
    let url = '';

    if (card) {
      const bioEl = card.querySelector('[data-testid="UserDescription"]');
      bio = norm(bioEl?.textContent || '');

      const locEl = card.querySelector('[data-testid="UserLocation"]');
      location = norm(locEl?.textContent || '');

      const urlEl = card.querySelector('[data-testid="UserUrl"]');
      url = norm(urlEl?.textContent || '');
    }

    // UI由来テキスト（フォローする等）が混ざらないよう、ユーザー入力系だけ合成
    const profileText = norm([bio, location, url].filter(Boolean).join('\n'));

    // hover解除（カードを閉じる）
    profileLinkEl.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, cancelable: true, view: window }));
    profileLinkEl.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true, cancelable: true, view: window }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    return { bio, profileText };
  }

  async function openTweetMenu(article) {
    const btn =
      article.querySelector('button[data-testid="caret"]') ||
      article.querySelector('[aria-label="More"]') ||
      article.querySelector('[aria-label="もっと見る"]') ||
      null;

    if (!btn) return false;
    btn.click();

    // メニューが出るまで少し待つ
    const start = Date.now();
    while (Date.now() - start < 1200) {
      const menu = document.querySelector('div[role="menu"]');
      if (menu) return true;
      await sleep(50);
    }
    return false;
  }

  async function clickMenuItemByText(textCandidates) {
    const start = Date.now();
    while (Date.now() - start < 1200) {
      const items = Array.from(document.querySelectorAll('div[role="menuitem"], a[role="menuitem"], button[role="menuitem"]'));
      for (const it of items) {
        const t = norm(it.textContent || '');
        if (!t) continue;
        if (textCandidates.some((c) => t.includes(c))) {
          it.click();
          return true;
        }
      }
      await sleep(50);
    }
    return false;
  }

  async function confirmDialogIfNeeded(action) {
    if (action !== 'block') return true;
    // ブロックは確認ダイアログが出ることが多い
    const start = Date.now();
    while (Date.now() - start < 1500) {
      const buttons = Array.from(document.querySelectorAll('div[role="dialog"] button'));
      for (const b of buttons) {
        const t = norm(b.textContent || '');
        if (t === 'ブロック' || t === 'Block') {
          b.click();
          return true;
        }
      }
      await sleep(60);
    }
    return false;
  }

  // ===== 判定・処置 =====
  const processedHandles = new Set();
  const profileCache = new Map(); // handle -> {bio, profileText, ts}

  async function evaluateAndActOnArticle(article) {
    const userNameBlock = extractUserNameBlock(article);
    if (!userNameBlock) return;

    const displayName = extractDisplayName(userNameBlock);
    const handle = extractHandle(userNameBlock);
    if (!handle) return;
    if (processedHandles.has(handle)) return;

    // 返信欄だけを対象にしたいので /status/ 以外では動かさない（誤爆防止）
    if (!location.pathname.includes('/status/')) return;

    // 条件1: 表示名に日本語が含まれていない
    const cond1 = !hasJapanese(displayName);

    // 条件2: 認証済みアカウントである
    const cond2 = isVerified(userNameBlock);

    if (!cond1 || !cond2) {
      processedHandles.add(handle);
      return;
    }

    // プロフィール情報取得（ホバーカード）
    let cached = profileCache.get(handle);
    if (!cached || (Date.now() - cached.ts) > 10 * 60 * 1000) {
      const profileLink = findProfileLink(userNameBlock, handle) || userNameBlock.querySelector('a[href^="/"]');
      const { bio, profileText } = await readProfileFromHoverCard(profileLink);
      cached = { bio, profileText, ts: Date.now() };
      profileCache.set(handle, cached);
      // 少し間隔を開ける（UI安定化）
      await sleep(120);
    }

    const bio = cached.bio || '';
    const profileText = cached.profileText || '';

    // 条件3: プロフィール(bio)に "Web3" "Crypto" "AI" のいずれかが含まれている
    const cond3 = includesAnyKeyword(bio);

    // 条件4: プロフィール（ユーザー入力部分）に日本語が含まれていない
    const cond4 = !hasJapanese(profileText);

    const shouldAct = cond1 && cond2 && cond3 && cond4;

    if (!shouldAct) {
      processedHandles.add(handle);
      return;
    }

    const reason = {
      cond1, cond2, cond3, cond4,
      displayName,
      bio: bio.slice(0, 140),
      profileText: profileText.slice(0, 140),
    };

    if (DRY_RUN) {
      log(`DRY_RUN: ${ACTION} 対象`, `@${handle}`, reason);
      processedHandles.add(handle);
      return;
    }

    log(`${ACTION} 実行`, `@${handle}`, reason);

    const opened = await openTweetMenu(article);
    if (!opened) {
      log('メニューを開けませんでした', `@${handle}`);
      processedHandles.add(handle);
      return;
    }

    if (ACTION === 'mute') {
      const ok = await clickMenuItemByText(['ミュート', 'Mute']);
      if (!ok) log('ミュート項目が見つかりません', `@${handle}`);
    } else {
      const ok = await clickMenuItemByText(['ブロック', 'Block']);
      if (!ok) {
        log('ブロック項目が見つかりません', `@${handle}`);
      } else {
        await confirmDialogIfNeeded('block');
      }
    }

    processedHandles.add(handle);
  }

  let lastScanAt = 0;
  let scanRunning = false;

  async function scanLoop() {
    if (scanRunning) return;
    scanRunning = true;
    try {
      const now = Date.now();
      if (now - lastScanAt < SCAN_INTERVAL_MS) return;
      lastScanAt = now;

      const root = getConversationRoot();
      if (!root) return;

      const articles = getTweetArticles(root);
      for (const a of articles) {
        // 処理負荷とUI安定のため逐次
        await evaluateAndActOnArticle(a);
      }
    } catch (e) {
      log('scan error', e);
    } finally {
      scanRunning = false;
    }
  }

  // 変更監視（返信が追加ロードされるため）
  const mo = new MutationObserver(() => {
    // 連打を避けて軽く遅延
    setTimeout(scanLoop, 250);
  });
  mo.observe(document.body, { childList: true, subtree: true });

  // 初回
  setTimeout(scanLoop, 1200);

  log('loaded', { ACTION, DRY_RUN, KEYWORDS });
})();