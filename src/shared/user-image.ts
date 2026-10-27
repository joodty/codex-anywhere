/** Preserve the path of a native user image without forwarding its base64 body. */
export function userImageAttachment(content: unknown): { path: string; name: string } | undefined {
  return userImageAttachments(content)[0];
}

export function userImageAttachments(content: unknown): Array<{ path: string; name: string }> {
  const images: Array<{ path: string; name: string }> = [];
  if (!Array.isArray(content)) return images;
  for (const item of content) {
    const path = item?.type === 'localImage' ? item.path
      : typeof item?.text === 'string' ? /<image\b[^>]*\bpath="([^"]+)"/i.exec(item.text)?.[1] : undefined;
    if (typeof path === 'string' && path.length <= 4096 && !/[\u0000-\u001f]/.test(path)) {
      if (!images.some(image => image.path === path)) images.push({ path, name: path.split(/[\\/]/).at(-1) || 'image' });
    }
  }
  return images.slice(0, 6);
}
