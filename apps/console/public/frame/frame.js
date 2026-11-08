/*
 * The artifact frame's loader. The Console frames /frame.html (sandbox="allow-scripts", no same origin), whose own response
 * policy closes every network channel. The page sends the artifact as {type:'factory.render', html, annotate}; only the
 * parent window is believed, and only once. document.open() drops the window's listeners, so the annotator is added after
 * the write and registers its own.
 */
;(() => {
  let rendered = false
  window.addEventListener('message', (event) => {
    if (event.source !== parent || rendered) return
    const data = event.data
    if (data?.type !== 'factory.render' || typeof data.html !== 'string') return
    rendered = true
    const annotator = data.annotate === false ? '' : `<script src="/frame/annotator.js"></${'script'}>`
    document.open()
    document.write(data.html + annotator)
    document.close()
    // document.open() dropped frame.html's head, so the lock is added again for the artifact's own document.
    const lock = document.createElement('meta')
    lock.name = 'darkreader-lock'
    document.head.appendChild(lock)
  })
})()
