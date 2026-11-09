export const OS_LINE = 'Node 20+ · MIT licensed';
export const INSTALL_COMMAND = 'npx getbotons install';
export const REPO_URL = 'https://github.com/boundsj/botons';
export const CONTACT = 'hello@getbotons.com';

// All text presented on the site lives here, including accessible labels and metadata.
export const COPY = {
  brandName: 'Botons',
  title: 'Botons · A home for your AI agents',
  description: 'Your own team of AI agents, powered by the AI you already use. Give each one a role, and they get to work: on your computer, on a schedule, together.',
  skip: 'Skip to content',
  navLabel: 'Main navigation',
  nav: { features: 'Features', compare: 'How it compares', install: 'Get started', github: 'GitHub' },
  hero: {
    eyebrow: 'Self-hosted · open source',
    heading: 'A home for your AI agents.',
    headingFirst: 'A home for',
    headingSecond: 'your AI agents.',
    crewLabel: 'A team of seven Botons with roles: Inbox, Research, Ops, Code review, Writer and Scheduler',
    roles: ['Inbox', 'Research', 'Ops', '', 'Code review', 'Writer', 'Scheduler'],
  },
  copy: 'Copy',
  copied: 'Copied',
  copiedAnnouncement: 'Command copied to clipboard.',
  selectAnnouncement: 'Command selected. Copy it using your keyboard.',
  viewGithub: 'View on GitHub',
  features: {
    eyebrow: 'What a Boton gets',
    heading: 'Give each Boton a job.',
    lede: 'Every Boton has its own role, chat, routines, memory and files.',
    tiles: [
      ['Its own chat', 'Talk to each Boton like a teammate.'],
      ['Routines', 'Jobs on a schedule or a webhook.'],
      ['Memory', 'It remembers what matters to you.'],
      ['Files', 'A workspace for its work.'],
      ['Connectors', 'GitHub, Linear, Slack and more.'],
      ['Web and computer', 'It browses and clicks. You take over for logins.'],
      ['Asks first', 'Risky steps wait for your OK.'],
      ['A team', 'Botons ask each other for help.'],
    ],
  },
  brains: {
    eyebrow: 'The AI you already use',
    heading: 'Bring your own AI.',
    lede: 'Botons runs your own Claude Code or Codex, signed in on your box. Or give a Boton an API key.',
    rows: [['Claude Code', 'your own CLI'], ['Codex', 'your own CLI'], ['API key', 'pay per use']],
  },
  phone: {
    eyebrow: 'In your pocket', heading: 'Check in from your phone.',
    bullets: ['Chat with any Boton.', 'Approve a step with one tap.', 'See what your routines did.', 'Add it to your home screen.'],
    name: 'Scout', message: 'I found the form. It needs your OK to submit.',
    question: 'Submit the booking form?', domain: 'reserve.example.com', allow: 'Allow once', deny: 'Not now',
  },
  install: {
    eyebrow: 'Get started', heading: 'Your first Boton in a few minutes.',
    lede: 'Four small steps on your own computer. All you need is Node 20 or newer.',
    steps: [
      ['Bring your AI', 'Sign in to Claude Code or Codex. Botons runs the one you already use.'],
      ['Run one command', 'Paste it into a terminal.'],
      ['Open the link', 'Open the link it prints, then approve the code it shows.'],
      ['Make a Boton', 'Pick a look, give it a role, and say hello.'],
    ],
    docsLink: 'Read the full install guide',
    noteBefore: 'Prefer containers? ', noteLink: "There's a Docker setup too.",
  },
  compare: {
    eyebrow: 'How it compares', heading: 'Where Botons fits.', caption: 'How Botons compares with other agent tools',
    columns: ['', 'Botons', 'Hosted agent services', 'Desktop agent apps', 'Terminal agents'],
    rows: [
      ['Runs on', 'Your own box or VM', "The vendor's cloud", "Your laptop, while it's awake", 'Your machine'],
      ['Brains', 'Your own Claude Code or Codex, or an API key', "Usually the vendor's choice", 'Varies by app', 'Usually API keys'],
      ['Your logins', 'Stay on your box', 'Held by the service', 'Stay on your laptop', 'Stay on your machine'],
      ['License', 'MIT', 'Usually closed', 'Varies', 'Varies'],
    ],
    notYet: 'Not yet:', gaps: ['a hosted version', 'a native phone app'],
    scrollLabel: 'Comparison table, scroll horizontally to see all columns',
  },
  cta: { eyebrow: 'Lights on', heading: 'Make your first Boton.' },
  footer: { license: 'MIT licensed', independent: 'Botons is independent and not affiliated with the makers of Claude Code or Codex.' },
} as const;
