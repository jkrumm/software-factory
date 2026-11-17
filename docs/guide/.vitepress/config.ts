import { defineConfig } from 'vitepress'

// The chapters are plain GitHub-flavoured Markdown that reads the same on github.com: no frontmatter, no Vue, no `:::`
// containers (scripts/guide-links.ts holds that). Everything site-only lives here and in the theme.
const repo = 'https://github.com/jkrumm/software-factory'

const chapters = [
  { text: 'Signals and Triage', link: '/signals' },
  { text: 'Issues', link: '/issues' },
  { text: 'Leads', link: '/leads' },
  { text: 'Gates', link: '/gates' },
  { text: 'Capacity', link: '/capacity' },
  { text: 'Chains and Plans', link: '/chains' },
  { text: 'Checkpoints', link: '/checkpoints' },
  { text: 'Loops', link: '/loops' },
  { text: 'Learnings', link: '/learnings' },
  { text: 'Running a Factory', link: '/running' },
]

export default defineConfig({
  title: 'Software Factory',
  description: 'Coding agents that ship to production unattended, explained through the system that does it.',
  lang: 'en',
  base: '/',
  cleanUrls: true,
  lastUpdated: false,
  // README.md is the folder's page on GitHub and the site's home.
  rewrites: { 'README.md': 'index.md' },
  srcExclude: ['diagrams/**', 'node_modules/**'],
  head: [['link', { rel: 'icon', href: '/glyph.svg', type: 'image/svg+xml' }]],
  markdown: { theme: { light: 'github-light', dark: 'github-dark' } },
  themeConfig: {
    logo: '/glyph.svg',
    nav: [
      { text: 'Guide', link: '/signals' },
      { text: 'Source', link: repo },
    ],
    sidebar: [{ text: 'Software Factory', link: '/' }, { text: 'Chapters', items: chapters }],
    outline: { level: [2, 3] },
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: repo }],
    editLink: { pattern: `${repo}/edit/master/docs/guide/:path`, text: 'Edit this page on GitHub' },
    footer: { message: 'MIT licensed.' },
  },
})
