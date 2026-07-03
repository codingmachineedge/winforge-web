// App-wide shell feedback strings: toast dismiss control + error-boundary fallback UI.
// Single top-level namespace `shellfb`. EN + 粵語 (Traditional Chinese, natural spoken
// Cantonese WinForge wording — not Mandarin). Merged into the language bundles by the
// orchestrator (alongside en / zh-Hant / batchB).

export const enShellFeedback = {
  shellfb: {
    // Toast
    dismiss: 'Dismiss',
    // Error boundary
    somethingWentWrong: 'Something went wrong',
    unknownError: 'An unknown error occurred.',
    showDetails: 'Show details',
    copyDetails: 'Copy details',
    copied: 'Copied',
    retry: 'Retry',
  },
};

export const yueShellFeedback: typeof enShellFeedback = {
  shellfb: {
    // Toast
    dismiss: '關閉',
    // Error boundary
    somethingWentWrong: '出咗問題',
    unknownError: '發生咗未知錯誤。',
    showDetails: '睇詳情',
    copyDetails: '複製詳情',
    copied: '複製咗',
    retry: '再試',
  },
};
