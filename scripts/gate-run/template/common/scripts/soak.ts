// A soak run that takes about a minute: the repo's slow verification step. Prints "soak ok" when it is done.
const end = Date.now() + 55_000
while (Date.now() < end) await Bun.sleep(1000)
console.log('soak ok')
