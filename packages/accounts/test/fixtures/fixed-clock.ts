// Preloaded into both CLIs of the parity test: one clock, one random source.
const now = Number(process.env.PARITY_NOW)
if (!Number.isFinite(now)) throw new Error('PARITY_NOW is not set')
Date.now = () => now
Math.random = () => 0.5
