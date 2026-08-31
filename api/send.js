// api/send.js
import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import axios from 'axios';

chromium.use(stealthPlugin());

const DEFAULT_PROXY_API = 'https://api.ikyyxd.my.id/v2l/proxy-free/ikyy-xsample';

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { channelUrl, reactions, username, password, useProxy } = req.body;

        // Validasi
        if (!channelUrl) {
            return res.status(400).json({ error: 'channelUrl required' });
        }

        if (!reactions || !Array.isArray(reactions) || reactions.length === 0) {
            return res.status(400).json({ error: 'reactions required (array)' });
        }

        const result = await sendReaction(channelUrl, reactions, username, password, useProxy);
        
        return res.status(200).json(result);
    } catch (error) {
        console.error('Error:', error);
        return res.status(500).json({ 
            error: error.message || 'Internal server error' 
        });
    }
}

async function sendReaction(channelUrl, reactions, username, password, useProxy) {
    let browser = null;
    let proxyConfig = null;

    try {
        // Fetch proxy jika diperlukan
        if (useProxy) {
            const proxies = await fetchProxies();
            if (proxies.length > 0) {
                const randomProxy = proxies[Math.floor(Math.random() * proxies.length)];
                proxyConfig = parseProxyString(randomProxy);
            }
        }

        // Generate username & password jika tidak disediakan
        const finalUsername = username || generateRandomUsername();
        const finalPassword = password || `Pass_${Math.random().toString(36).substring(2, 10)}!`;

        // Launch browser
        const launchOptions = {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-web-security'
            ]
        };

        if (proxyConfig) {
            launchOptions.proxy = proxyConfig;
        }

        browser = await chromium.launch(launchOptions);
        const page = await browser.newPage();
        
        // Set viewport
        await page.setViewportSize({ width: 1280, height: 720 });

        // Navigasi ke website
        await page.goto('https://reach-wa-nexus.vercel.app', { 
            waitUntil: 'networkidle', 
            timeout: 30000 
        });

        await page.waitForTimeout(2000);

        // Klik tab Register
        await page.click('#nxAuthRegister', { force: true });
        await page.waitForTimeout(1000);

        // Isi form registrasi
        await page.fill('#nxUsername', finalUsername);
        await page.fill('#nxPassword', finalPassword);
        
        await page.click('#nxProfileSave', { force: true });
        await page.waitForTimeout(2000);

        // Close modal
        await page.click('#nxProfileBg', { force: true });
        await page.waitForTimeout(1000);

        // Isi URL channel
        const linkInput = await page.$('#channelUrl');
        if (linkInput) {
            await linkInput.fill(channelUrl);
            await page.waitForTimeout(500);
        }

        // Isi reactions
        const customInput = await page.$('#customReaction');
        if (customInput) {
            await customInput.fill(reactions.join(', '));
            await page.waitForTimeout(500);
        }

        // Klik Terapkan
        const applyBtn = await page.$('#addCustom');
        if (applyBtn) {
            await applyBtn.click({ force: true });
            await page.waitForTimeout(500);
        }

        // Klik Send
        await page.click('#sendBtn', { force: true });
        await page.waitForTimeout(3000);

        // Cek hasil
        let finalTitle = '';
        let finalBody = '';
        let isSuccess = false;

        for (let i = 0; i < 15; i++) {
            await page.waitForTimeout(1000);
            
            finalTitle = await page.$eval('#responseTitle', el => el.innerText).catch(() => '');
            finalBody = await page.$eval('#responseBody', el => el.innerText).catch(() => '');
            
            const pageText = await page.innerText('body');
            isSuccess = finalTitle.includes('berhasil') || 
                       finalBody.includes('berhasil') || 
                       pageText.includes('berhasil');

            if (isSuccess) break;
        }

        await browser.close();

        if (isSuccess) {
            return {
                success: true,
                message: finalTitle ? `${finalTitle} — ${finalBody}` : 'Reaction berhasil terkirim',
                usernameUsed: finalUsername,
                passwordUsed: finalPassword,
                proxyUsed: proxyConfig ? proxyConfig.server : 'Direct'
            };
        } else {
            return {
                success: false,
                error: 'Gagal mengirim reaction. Mungkin limit/coin habis.',
                usernameUsed: finalUsername
            };
        }

    } catch (error) {
        if (browser) await browser.close().catch(() => {});
        return {
            success: false,
            error: error.message || 'Terjadi kesalahan'
        };
    }
}

async function fetchProxies(proxyApiUrl = DEFAULT_PROXY_API) {
    try {
        const res = await axios.get(proxyApiUrl, { timeout: 5000 });
        if (Array.isArray(res.data) && res.data.length > 0) {
            return res.data;
        }
    } catch (_) {}
    return [];
}

function parseProxyString(proxyStr) {
    if (!proxyStr || typeof proxyStr !== 'string') return null;
    const parts = proxyStr.split(':');
    if (parts.length >= 4) {
        const [ip, port, username, password] = parts;
        return { server: `http://${ip}:${port}`, username, password };
    } else if (parts.length === 2) {
        const [ip, port] = parts;
        return { server: `http://${ip}:${port}` };
    }
    return null;
}

function generateRandomUsername() {
    const prefixes = ['user', 'member', 'player', 'nexus', 'acc', 'wa_usr'];
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    const randStr = Math.random().toString(36).substring(2, 8);
    const randNum = Math.floor(Math.random() * 900 + 100);
    return `${prefix}_${randStr}${randNum}`;
}
