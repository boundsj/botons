// Copy is an enhancement: the command remains selectable without JavaScript or clipboard access.
const status = document.querySelector('#copy-status');
let announcementFrame;
function clearAnnouncement() {
  cancelAnimationFrame(announcementFrame);
  status.textContent = '';
}
function announce(message) {
  clearAnnouncement();
  announcementFrame = requestAnimationFrame(() => { status.textContent = message; });
}
for (const button of document.querySelectorAll('.copy-button')) {
  const code = button.parentElement.querySelector('code');
  const label = button.textContent;
  button.hidden = false;
  let reset;
  button.addEventListener('click', async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(code.textContent);
      button.textContent = button.dataset.copied;
      announce(button.dataset.success);
      clearTimeout(reset);
      reset = setTimeout(() => { button.textContent = label; clearAnnouncement(); }, 2500);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      announce(button.dataset.select);
    }
  });
}
