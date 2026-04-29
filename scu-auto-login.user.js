// ==UserScript==
// @name         SCU 统一身份认证自动登录
// @namespace    https://github.com/meteor-liu-xinyu
// @version      1.0
// @description  在四川大学统一身份认证页自动使用外部OCR识别验证码并尝试填写学号/密码并登录。
// @match        *://id.scu.edu.cn/*
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // 直接在脚本中写入配置（请谨慎保存密码）
    const OCR_PROVIDER = 'https://example.com/ocr'; // <- 在此填入你的 OCR 服务 URL
    const STUDENT_ID = 'yourStudentId'; // <- 在此填入学号
    const PASSWORD = 'yourPassword'; // <- 在此填入密码（谨慎）
    // 开关：开启/关闭各自动化步骤（可设置为 true/false）
    const AUTO_FILL_USERNAME = true; // 自动填写学号
    const AUTO_FILL_PASSWORD = true; // 自动填写密码
    const AUTO_OCR_CAPTCHA = true;   // 自动识别并填写验证码
    const AUTO_SUBMIT = true;        // 自动提交登录表单

    const MAX_ATTEMPTS = 5;
    const WINDOW_MS = 60 * 1000;
    const INITIAL_WAIT_MS = 800; // 初始等待（ms），让页面和验证码有时间加载

    // 重试控制：1分钟内最多5次
    let attemptCount = 0;
    let firstAttemptTs = 0;
    
    async function ocr_external_from_img(imgEl, provider) {
        if (!imgEl) throw new Error('no image element');
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no canvas ctx');
        canvas.width = imgEl.width || imgEl.naturalWidth || 100;
        canvas.height = imgEl.height || imgEl.naturalHeight || 40;
        ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
        const data = canvas.toDataURL('image/png');
        const base64 = data.split(',')[1];
        const body = JSON.stringify({ img: base64 });
        const res = await fetch(provider, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        if (!res.ok) throw new Error('OCR provider response ' + res.status);
        const j = await res.json();
        return j.result || j.text || j.data || '';
    }

    // 辅助：查找用户名输入
    function findUsernameInput() {
        let el = document.querySelector('input[name="username"]') || document.querySelector('#username') || null;
        if (el) return el;
        // 尝试 placeholder 或 type=text
        el = document.querySelector('input[placeholder*="学号"]') || null;
        if (el) return el;
        const inputs = Array.from(document.querySelectorAll('input'));
        for (const ii of inputs) {
            const t = (ii.getAttribute('type') || '').toLowerCase();
            if (t === 'text' || t === '' || t === 'email') {
                // 排除密码和验证码可能使用的 input
                if ((ii.getAttribute('name') || '').toLowerCase().includes('validate') || (ii.getAttribute('name') || '').toLowerCase().includes('captcha')) continue;
                return ii;
            }
        }
        return null;
    }

    // 辅助：查找与 img 相邻或表单内的验证码输入
    function findCaptchaInput(imgEl) {
        // 常见 name
        let el = document.querySelector('input[name="validateCode"], input[name="captcha"]');
        if (el) return el;
        // 在同一表单中查找 text input
        try {
            const form = imgEl && imgEl.closest && imgEl.closest('form');
            if (form) {
                const cand = form.querySelectorAll('input[type="text"], input');
                if (cand && cand.length) {
                    // 选择最靠近 img 的一个
                    let best = null;
                    let bestDist = Infinity;
                    const imgRect = imgEl.getBoundingClientRect();
                    for (const c of cand) {
                        const t = (c.getAttribute('type') || '').toLowerCase();
                        if (t === 'password') continue;
                        const r = c.getBoundingClientRect();
                        const dx = (r.left + r.right) / 2 - (imgRect.left + imgRect.right) / 2;
                        const dy = (r.top + r.bottom) / 2 - (imgRect.top + imgRect.bottom) / 2;
                        const d = Math.hypot(dx, dy);
                        if (d < bestDist) { bestDist = d; best = c; }
                    }
                    if (best) return best;
                }
            }
        } catch (e) { /* ignore */ }
        // 最后尝试在文档中找第一个看起来像验证码的短输入（长度小）
        const inputsAll = Array.from(document.querySelectorAll('input[type="text"], input')).filter(i => (i.getAttribute('type') || '').toLowerCase() !== 'password');
        for (const i of inputsAll) {
            const maxlen = parseInt(i.getAttribute('maxlength') || '0', 10);
            if (maxlen > 0 && maxlen <= 6) return i;
            const w = i.offsetWidth;
            if (w && w < 200) return i;
        }
        return null;
    }

    async function fillAndSubmit(settings, imgEl) {
        try {
            const usernameInput = findUsernameInput();
            const captchaInput = findCaptchaInput(imgEl);

            // 处理用户名
            let filledUsername = false;
            if (settings.autoFillUsername) {
                if (usernameInput && settings.studentId && settings.studentId.trim()) {
                    usernameInput.value = settings.studentId.trim();
                    usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
                    filledUsername = true;
                } else {
                    filledUsername = false;
                }
            } else {
                filledUsername = true; // 用户选择不自动填写视为已满足
            }

            // OCR 验证码（仅在开启且存在图片时执行）
            let ocrResult = '';
            if (settings.autoOcrCaptcha && settings.ocrProvider && imgEl && captchaInput) {
                try {
                    ocrResult = await ocr_external_from_img(imgEl, settings.ocrProvider);
                } catch (e) {
                    console.warn('OCR 请求失败', e);
                }
                if (ocrResult && captchaInput) {
                    captchaInput.value = ocrResult;
                    captchaInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }

            // 密码
            let pwdEl = document.querySelector('input[type="password"]') || document.querySelector('input[name="password"]') || document.querySelector('#password');
            let filledPassword = false;
            if (settings.autoFillPassword) {
                if (pwdEl && settings.password && settings.password.trim()) {
                    pwdEl.value = settings.password.trim();
                    pwdEl.dispatchEvent(new Event('input', { bubbles: true }));
                    filledPassword = true;
                } else {
                    filledPassword = false;
                }
            } else {
                filledPassword = true; // 不自动填写密码视为已满足
            }

            const didFillCaptcha = (!settings.autoOcrCaptcha) || (captchaInput && (captchaInput.value || ocrResult));
            const filledAll = filledUsername && filledPassword && didFillCaptcha;

            // submit：只有在同时开启自动填写学号和密码时才真正允许自动提交
            const effectiveAutoSubmit = settings.autoSubmit && settings.autoFillUsername && settings.autoFillPassword;
            let submitted = false;
            if (effectiveAutoSubmit) {
                // 当未开启 OCR 自动识别时，等待验证码输入框填入至少 4 个字符才提交
                const captchaReadyForSubmit = settings.autoOcrCaptcha ? true : (captchaInput && (captchaInput.value || '').trim().length >= 4);
                if (captchaReadyForSubmit) {
                    const formEl = (captchaInput && captchaInput.closest) ? captchaInput.closest('form') : (imgEl && imgEl.closest ? imgEl.closest('form') : null);
                    if (formEl) {
                        const btn = formEl.querySelector('button[type="submit"], input[type="submit"]');
                        if (btn) { btn.click(); submitted = true; }
                    }
                    if (!submitted) {
                        const buttons = Array.from(document.querySelectorAll('button'));
                        for (const b of buttons) {
                            const t = (b.textContent||'').replace(/\s+/g,'');
                            if (t.includes('登录') || t.toLowerCase().includes('login')) { b.click(); submitted = true; break; }
                        }
                    }
                } else {
                    // 不满足验证码长度时，不提交；让主流程继续重试或等待用户填写
                    submitted = false;
                }
            } else {
                // 如果不允许自动提交，但所有字段已经被填写完毕，则视为“已完成”以停止自动重试
                if (filledAll) submitted = true;
            }

            return { submitted, ocrResult, usernameInput, captchaInput };
        } catch (e) {
            console.error('fillAndSubmit error', e);
            return { submitted: false };
        }
    }

    async function mainProcess(force=false) {
        try {
            const settings = {
                ocrProvider: OCR_PROVIDER,
                studentId: STUDENT_ID,
                password: PASSWORD,
                autoFillUsername: AUTO_FILL_USERNAME,
                autoFillPassword: AUTO_FILL_PASSWORD,
                autoOcrCaptcha: AUTO_OCR_CAPTCHA,
                autoSubmit: AUTO_SUBMIT
            };
            // try locate the captcha image by common selectors used on SCU login
            const imgEl = document.querySelector('.captcha-img') || document.querySelector('img[alt*="captcha"]') || document.querySelector('img.captcha') || null;
            if (!imgEl) {
                if (force) alert('未找到验证码图片元素');
                return;
            }
            if (!settings.ocrProvider) {
                if (force) alert('未设置 OCR 服务地址。');
                return;
            }

            const now = Date.now();
            if (!firstAttemptTs || now - firstAttemptTs > WINDOW_MS) {
                firstAttemptTs = now;
                attemptCount = 0;
            }
            if (attemptCount >= MAX_ATTEMPTS) {
                if (force) alert('已达到最大尝试次数（1分钟内最多 ' + MAX_ATTEMPTS + ' 次）');
                console.warn('max attempts reached');
                return;
            }
            attemptCount++;

            const res = await fillAndSubmit(settings, imgEl);
            if (res && res.submitted) {
                // 成功提交，重置计数
                attemptCount = 0; firstAttemptTs = 0;
                return;
            }

            // 未成功提交：在允许的次数内处理重试或等待用户输入
            if (attemptCount < MAX_ATTEMPTS && Date.now() - firstAttemptTs <= WINDOW_MS) {
                try {
                    if (settings.autoOcrCaptcha) {
                        // 自动 OCR 开启时尝试刷新验证码并重试
                        if (imgEl.click) imgEl.click();
                        const refreshBtn = imgEl.closest && imgEl.closest('form') ? imgEl.closest('form').querySelector('.refresh, .captcha-refresh, a[onclick], button[onclick]') : null;
                        if (refreshBtn && refreshBtn.click) refreshBtn.click();
                        // 等待一段时间再尝试（5秒）
                        setTimeout(() => mainProcess(false), 5000);
                    } else {
                        // 未开启 OCR：不要自动刷新验证码，改为监听验证码输入变化，用户输入达到要求时再提交一次
                        if (res && res.captchaInput && !res.captchaInput.dataset.scuAutoListener) {
                            res.captchaInput.dataset.scuAutoListener = '1';
                            const onInput = function() {
                                try {
                                    if ((res.captchaInput.value || '').trim().length >= 4) {
                                        res.captchaInput.removeEventListener('input', onInput);
                                        delete res.captchaInput.dataset.scuAutoListener;
                                        // 轻微延迟后再次运行主流程以尝试提交
                                        setTimeout(() => mainProcess(false), 100);
                                    }
                                } catch (e) { /* ignore */ }
                            };
                            res.captchaInput.addEventListener('input', onInput);
                        }
                    }
                } catch (e) { /* ignore */ }
            } else {
                if (force) alert('重试次数已用尽，请手动尝试。');
            }
        } catch (e) {
            console.error(e);
        }
    }

    // 等待直到能找到验证码图片或超时
    async function waitForCaptchaImage(timeout = 5000, pollInterval = 250) {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
            const img = document.querySelector('.captcha-img') || document.querySelector('img[alt*="captcha"]') || document.querySelector('img.captcha');
            if (img) {
                if (img.complete) return img;
                // 等待图片的 load 事件或短超时
                try {
                    await new Promise(resolve => {
                        const onLoad = () => { img.removeEventListener('load', onLoad); resolve(true); };
                        img.addEventListener('load', onLoad);
                        // 以防 load 事件不触发，短超时后继续循环
                        setTimeout(resolve, pollInterval);
                    });
                    if (img.complete) return img;
                } catch (e) { /* ignore */ }
            }
            await new Promise(r => setTimeout(r, pollInterval));
        }
        return null;
    }

    async function initAutoOnLoad() {
        // 初始短等待，给页面脚本时间运行
        await new Promise(r => setTimeout(r, INITIAL_WAIT_MS));

        const img = await waitForCaptchaImage(5000, 300);
        if (img) {
            // 当图片加载完成或已完成时触发主流程
            if (img.complete) setTimeout(() => mainProcess(false), 300);
            img.addEventListener('load', () => { setTimeout(() => mainProcess(false), 300); });
        } else {
            // 回退：如果未找到验证码图片，还是在 DOMContentLoaded 时尝试一次
            document.addEventListener('DOMContentLoaded', () => { setTimeout(() => mainProcess(false), 600); });
            // 并在初始等待后再尝试一次
            setTimeout(() => mainProcess(false), INITIAL_WAIT_MS + 500);
        }
    }

    initAutoOnLoad();

})();
