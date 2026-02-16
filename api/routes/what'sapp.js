import { kordid } from './id.js'
import express from 'express'
import fs from 'fs'
import path from 'path'
import os from 'os'
import axios from 'axios'
import pino from 'pino'
import QRCode from 'qrcode'
import {
  default as makeWASocket,
  useMultiFileAuthState,
  delay,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  Browsers
} from 'baileys'
import NodeCache from 'node-cache'

const router = express.Router()

const msgCache = new NodeCache()
const sessCache = new NodeCache({ stdTTL: 600 })

const API_KEY = process.env.KORD_AI_API_KEY || 'xxxx'
const sessions = new Map()

function getTempDir() {
  const tmp = process.env.VERCEL_TMP
  return tmp && fs.existsSync(tmp) ? tmp : os.tmpdir()
}

function createSessDir(sessId) {
  const base = getTempDir()
  const dir = path.join(base, `kordai_${sessId}`)
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    return dir
  } catch (error) {
    console.error(`Error creating session directory ${dir}:`, error)
    throw error
  }
}

async function cleanup(sessId) {
  try {
    const dir = path.join(getTempDir(), `kordai_${sessId}`)
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    const sock = sessions.get(sessId)
    if (sock) {
      await sock.ws.close()
      sessions.delete(sessId)
    }
    sessCache.del(sessId)
  } catch (error) {
    console.error(`Session cleanup error for ${sessId}:`, error)
  }
}

function sanitizeKey(key) {
  return key.replace(/[.#$\/\[\]]/g, '_')
}

function unsanitizeKey(key) {
  return key
}

async function uploadDir(dir) {
  try {
    const files = {}
    const items = await fs.promises.readdir(dir)

    for (const item of items) {
      const filePath = path.join(dir, item)
      const stat = await fs.promises.stat(filePath)

      if (stat.isFile() && item.endsWith('.json')) {
        const content = await fs.promises.readFile(filePath, 'utf8')
        try {
          const sanitizedKey = sanitizeKey(item)
          files[sanitizedKey] = {
            originalName: item,
            content: JSON.parse(content)
          }
        } catch (parseError) {
          console.warn(`Skipping invalid JSON file: ${item}`)
        }
      }
    }

    if (Object.keys(files).length === 0) {
      throw new Error('No valid JSON files found in directory')
    }

    /* Add your endpoint upload here */

    if (res.data?.status !== 'success' || !res.data?.data) {
      throw new Error('Invalid server response')
    }

    return res.data.data
  } catch (error) {
    console.error('Directory upload error:', error)
    throw new Error(`Directory upload failed: ${error.message}`)
  }
}

async function fetchDir(dirId) {
  try {
    /* add your endpoint fetch here */

    if (res.data?.status !== 'success' || !res.data?.data) {
      throw new Error('Invalid server response')
    }

    return res.data.data
  } catch (error) {
    console.error('Directory fetch error:', error)
    throw new Error(`Directory fetch failed: ${error.message}`)
  }
}

async function initWA(sessId, useQR = false) {
  const dir = createSessDir(sessId)
  const { state, saveCreds } = await useMultiFileAuthState(dir)
  const { version, isLatest } = await fetchLatestBaileysVersion()
  console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`)

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: useQR,
    version,
    logger: pino({ level: "fatal" }).child({ level: "fatal" }),
    msgRetryCounterCache: msgCache
  })

  sock.ev.on('creds.update', saveCreds)
  return { sock, dir }
}

async function animateText(sock, text) {
  let currentText = ""
  const sentMessage = await sock.sendMessage(sock.user.id, { text: currentText })
  
  for (let i = 0; i < text.length; i++) {
    currentText += text[i]
    await sock.sendMessage(sock.user.id, { text: currentText, edit: sentMessage.key })
    await delay(200)
  }
  
  await delay(500)
  
  for (let i = 0; i < text.length; i++) {
    currentText = text.substring(0, i)
    await sock.sendMessage(sock.user.id, { text: currentText, edit: sentMessage.key })
    await delay(150)
  }
  
  await delay(300)
  
  currentText = ""
  for (let i = 0; i < text.length; i++) {
    currentText += text[i]
    await sock.sendMessage(sock.user.id, { text: currentText, edit: sentMessage.key })
    await delay(180)
  }
  
  await delay(800)
  await sock.sendMessage(sock.user.id, { text: "done", edit: sentMessage.key })
  await delay(500)
  
  return sentMessage
}

async function handleConn(sock, dir, sessId) {
  try {
    await delay(10000)
    
      await animateText(sock, "syncin..")

    const result = await uploadDir(dir)
    const botId = `session-${result.directoryId}`
    const sess = await sock.sendMessage(sock.user.id, { text: botId })

    const msg = `
 /* construct your message */`

    const content = {
      text: msg,
      contextInfo: {
        forwardingScore: 999,
        isForwarded: true,
        mentionedJid: [sock.user.id],
        forwardedNewsletterMessageInfo: {
          newsletterName: "Name",
          newsletterJid: "xxxxxxxxxx@newsletter",
        },
      },
    }

    await sock.sendMessage(sock.user.id, content, { quoted: sess })
    await delay(6000)
    await cleanup(sessId)
  } catch (error) {
    console.error("Connection handling error:", error)
    await cleanup(sessId)
  }
}

async function handlePair(sessId, phone, res) {
  const { sock, dir } = await initWA(sessId)
  sessions.set(sessId, sock)

  try {
    if (!sock.authState.creds.registered) {
      await delay(1500)
      phone = phone.replace(/[^0-9]/g, '')
      const code = await sock.requestPairingCode(phone)
      if (!res.headersSent) {
        res.json({ code, sessionId: sessId })
      }
    }

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update
      if (connection === "open") {
        await handleConn(sock, dir, sessId)
      } else if (connection === "close" && lastDisconnect?.error?.output?.statusCode !== 401) {
        await delay(10000)
        await handlePair(sessId, phone, res)
      }
    })
  } catch (error) {
    console.error("Pairing service error:", error)
    await cleanup(sessId)
    if (!res.headersSent) {
      res.json({ code: "Service is Currently Unavailable" })
    }
  }
}

async function handleQR(sessId, res) {
  const { sock, dir } = await initWA(sessId, true)
  sessions.set(sessId, sock)

  let qrGenerated = false

  try {
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr && !qrGenerated) {
        qrGenerated = true
        try {
          const qrImage = await QRCode.toDataURL(qr)
          if (!res.headersSent) {
            res.json({ 
              qr: qrImage, 
              sessionId: sessId,
              message: "Scan the QR code with WhatsApp"
            })
          }
        } catch (qrError) {
          console.error("QR generation error:", qrError)
          if (!res.headersSent) {
            res.status(500).json({ error: "Failed to generate QR code" })
          }
        }
      }

      if (connection === "open") {
        await handleConn(sock, dir, sessId)
      } else if (connection === "close" && lastDisconnect?.error?.output?.statusCode !== 401) {
        await delay(10000)
        await handleQR(sessId, res)
      }
    })

    setTimeout(() => {
      if (!qrGenerated && !res.headersSent) {
        res.status(408).json({ error: "QR code generation timeout" })
        cleanup(sessId)
      }
    }, 30000)

  } catch (error) {
    console.error("QR service error:", error)
    await cleanup(sessId)
    if (!res.headersSent) {
      res.status(500).json({ error: "QR service is currently unavailable" })
    }
  }
}

router.get('/', async (req, res) => {
  const sessId = kordid()
  let phone = req.query.number

  if (!phone || !/^\d+$/.test(phone.replace(/[^0-9]/g, ''))) {
    return res.status(400).json({ error: 'Invalid phone number' })
  }

  const timeout = setTimeout(() => cleanup(sessId), 600000)

  try {
    await handlePair(sessId, phone, res)
  } catch (error) {
    console.error('Pairing process error:', error)
    clearTimeout(timeout)
    await cleanup(sessId)
    if (!res.headersSent) {
      res.status(500).json({ error: 'Pairing process failed' })
    }
  }
})

router.get('/qr', async (req, res) => {
  const sessId = kordid()
  const timeout = setTimeout(() => cleanup(sessId), 600000)

  try {
    await handleQR(sessId, res)
  } catch (error) {
    console.error('QR process error:', error)
    clearTimeout(timeout)
    await cleanup(sessId)
    if (!res.headersSent) {
      res.status(500).json({ error: 'QR process failed' })
    }
  }
})

router.get('/fetch-example/:dirId', async (req, res) => {
  try {
    const dirId = req.params.dirId
    const data = await fetchDir(dirId)

    res.json({
      success: true,
      message: 'Directory fetched successfully',
      data: data
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

export default router
