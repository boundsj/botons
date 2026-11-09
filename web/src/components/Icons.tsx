import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

export const SearchIcon = (p: P) => (<Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Svg>);
export const PlusIcon = (p: P) => (<Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>);
export const ClockIcon = (p: P) => (<Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>);
export const SendIcon = (p: P) => (<Svg {...p}><path d="M12 19V5M5 12l7-7 7 7" /></Svg>);
export const StopIcon = (p: P) => (<Svg {...p}><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" /></Svg>);
export const CloseIcon = (p: P) => (<Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>);
export const GearIcon = (p: P) => (<Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></Svg>);
export const PanelIcon = (p: P) => (<Svg {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></Svg>);
export const BackIcon = (p: P) => (<Svg {...p}><path d="m15 18-6-6 6-6" /></Svg>);
export const CopyIcon = (p: P) => (<Svg {...p}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></Svg>);
export const PlayIcon = (p: P) => (<Svg {...p}><path d="M7 5v14l11-7z" /></Svg>);
export const PauseIcon = (p: P) => (<Svg {...p}><path d="M8 5v14M16 5v14" /></Svg>);
export const TrashIcon = (p: P) => (<Svg {...p}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></Svg>);
export const CheckIcon = (p: P) => (<Svg {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></Svg>);
export const EditIcon = (p: P) => (<Svg {...p}><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m14 6 4 4" /></Svg>);
export const WebhookIcon = (p: P) => (<Svg {...p}><path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2" /><path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" /><path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8" /></Svg>);
export const DiceIcon = (p: P) => (<Svg {...p}><rect x="4" y="4" width="16" height="16" rx="3" /><circle cx="9" cy="9" r="1" fill="currentColor" /><circle cx="15" cy="15" r="1" fill="currentColor" /><circle cx="15" cy="9" r="1" fill="currentColor" /><circle cx="9" cy="15" r="1" fill="currentColor" /></Svg>);
export const BrainIcon = (p: P) => (<Svg {...p}><path d="M12 5a3 3 0 0 0-5.9.6A3 3 0 0 0 4 11a3 3 0 0 0 1 5.2A3 3 0 0 0 12 18z" /><path d="M12 5a3 3 0 0 1 5.9.6A3 3 0 0 1 20 11a3 3 0 0 1-1 5.2A3 3 0 0 1 12 18z" /></Svg>);
export const AlertIcon = (p: P) => (<Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></Svg>);
export const RefreshIcon = (p: P) => (<Svg {...p}><path d="M20 11a8 8 0 0 0-14.8-4M4 4v4h4M4 13a8 8 0 0 0 14.8 4M20 20v-4h-4" /></Svg>);
export const PaperclipIcon = (p: P) => (<Svg {...p}><path d="m21 11-8.6 8.6a5 5 0 0 1-7-7l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4L15.6 7" /></Svg>);
export const FolderIcon = (p: P) => (<Svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Svg>);
export const FileIcon = (p: P) => (<Svg {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></Svg>);
export const DownloadIcon = (p: P) => (<Svg {...p}><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></Svg>);
export const ExternalIcon = (p: P) => (<Svg {...p}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></Svg>);
export const PinIcon = (p: P) => (<Svg {...p}><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z" /><path d="M12 15v5" /></Svg>);
export const StarIcon = (p: P) => (<Svg {...p}><path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" /></Svg>);
export const BookIcon = (p: P) => (<Svg {...p}><path d="M5 5a2 2 0 0 1 2-2h12v14H7a2 2 0 0 0-2 2zM5 19a2 2 0 0 0 2 2h12v-4" /><path d="M9 7h6M9 10.5h4" /></Svg>);
export const ShieldIcon = (p: P) => (<Svg {...p}><path d="M12 3 5 6v5.5c0 4.3 2.9 8 7 9.5 4.1-1.5 7-5.2 7-9.5V6z" /><path d="m9 12 2.2 2.2L15.5 10" /></Svg>);
export const ChevronIcon = (p: P) => (<Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>);
export const SmileIcon = (p: P) => (<Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" /><path d="M9 9.5h.01M15 9.5h.01" /></Svg>);
export const MoreIcon = (p: P) => (<Svg {...p}><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" /></Svg>);
