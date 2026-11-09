# Files, the trash and the inbox

Each Boton has a workspace folder for its work. The shared folder (`shared/` in `BOTONS_HOME`) is read and written by Botons outside the Workspace sandbox. On macOS most of what follows needs Linux and is unavailable ([macOS](install.md#macos)).

## Files a Boton shares

A Boton's files open in its **Files** tab (and from the file chips in its chat): images, SVG, PDFs, Markdown and text show there; anything else, or anything over 25 MB, shows a card with its type and size, a **Download** button and why it has no preview. Files are a Boton's output, so none is ever shown as a page of the app. An SVG is shown as an image, which runs no script.

An HTML page (a design mock-up, a report) opens in a sandboxed frame with its own short-lived link, which **Open in a new tab** also uses. Its script runs, in an opaque origin, so it can't read the app's storage, cookies or pages, call `/api`, fetch, load resources from anywhere, submit forms, open windows or navigate the app's page. That also means a page shows only what it carries inline (styles, scripts, `data:` images and fonts): a font or script it would fetch from a CDN, or an image next to it in the workspace, doesn't load. A preview link opens only that one file, for an hour, and stops working when its device is revoked.

The sandbox is not network isolation. A page's script can still send what it holds (its own content, and its preview link, which it can read off its URL) by loading another address in its own frame or tab (the sandbox and CSP don't stop that), or over WebRTC. In the viewer, Botons closes the frame as soon as it loads a second page and shows the no-preview card, but the request has already gone; in a tab of its own nothing closes it. So what leaves is at most that one file and an hour-long link to it, never the device token, the device's files link or another file; but treat anything in a previewed page as something it could send. If the file is deleted, grows past 25 MB or its link expires after it was opened, the frame shows the no-preview card with why.

## Deleting files and the trash

In a Boton's **Files** tab, each row's **⋯** menu has **Delete**, and **Select** picks several files and folders to delete at once. A single file goes at once, with **Undo** in the notice; a folder, or several items, asks first.

Nothing is deleted outright: it moves to the server's trash (`trash/` in `BOTONS_HOME`, with where it was and whose it is). The trash button in Files lists that Boton's items with **Restore** and **Delete forever**.

- **Restore** puts an item back where it was, as `name-2.ext` if that name is taken now, its folders made again if they are gone. Where that can't be done (a file is in the way, say) it goes into the nearest folder on the way, and Restore says the original folder is gone and where it went. A restore never replaces anything, even a file a Boton puts at that name at the same moment: a file goes back by a hard link and a folder onto an empty folder it claims first, each of which fails if the name is taken. On a disk without hard links a file stays in the trash, with that reason.
- **Cleanup.** Each item is deleted for good 30 days after it went in. An item whose record (`meta.json`) can't be read, or whose deletion time is missing, not an exact time or in the future, is never deleted by that cleanup, only left and logged.
- **Safe against swaps.** A file a Boton swaps in while it is being deleted stays in the trash, as what it is, and the delete is refused: it is never renamed back over the name. The workspace itself and its `inbox` folder can't be deleted, and a path never leads out of the workspace: a symlink goes to the trash as the link, never what it points to, and a folder a Boton swaps for a link mid-delete or mid-restore changes nothing (the server works through the folder it checked, held open). That needs Linux's `/proc/self/fd`; where it isn't there, deleting to the trash, Restore, Clear inbox and the daily inbox cleanup are refused (Delete forever still works).
- **Other disks.** Moving to the trash is a rename, so a workspace or shared folder on another disk than `BOTONS_HOME` (a separate mount) can't use it: the delete is refused with that reason and nothing changes. Delete there with a Boton's own tools, or keep it on the same disk.
- **Who can.** Only a paired device can delete, restore or empty the trash; a Boton's own token can't. A Boton still deletes its own files with its own tools, which skip the trash.

Every delete, restore, Clear inbox and permanent deletion is in the audit log. The trash is not part of a backup.

## The inbox

Files you send a Boton land in its `inbox` folder. Once a day, inbox files untouched for 30 days go to the trash; **Settings → Storage** sets that to 7, 14, 30, 60 or 90 days, or **Off**.

In the inbox, **Keep in inbox** (in the row's menu) pins a file so neither the cleanup nor **Clear inbox** moves it: up to 1,000 in one inbox (one more is refused, never made room for by dropping another; a kept file that is no longer there frees its place). **Clear inbox** moves everything else there to the trash. Only files directly in the inbox are cleaned up daily: folders in it, anything a Boton moved out of it, the rest of the workspace and the shared folder never are.

## The shared folder

The Files tab's **Shared folder** button browses the shared folder the same way: delete files and folders to the trash, its own trash with **Restore** (back into the shared folder) and **Delete forever**, and download its files (they never open in the app, since any Boton can write them). The shared folder itself can't be deleted, and the daily cleanup never touches it.

## Storage

The Files tab shows what the workspace, its inbox, the Boton's trash and the shared folder take; **Settings → Storage** shows it for every Boton. `botons doctor` sums it in one line and warns past 1 GB in one inbox or 5 GB in all.
