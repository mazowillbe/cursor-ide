import { getExtensionIconUrl } from "../utils/fileIcons";

interface FileIconProps {
  path: string;
  className?: string;
  size?: number;
  title?: string;
}

export default function FileIcon({ path, className = "", size = 16, title }: FileIconProps) {
  const src = getExtensionIconUrl(path);
  if (!src) return null;
  return (
    <img
      src={src}
      alt=""
      className={className}
      width={size}
      height={size}
      style={{ width: size, height: size, flexShrink: 0 }}
      title={title}
    />
  );
}
