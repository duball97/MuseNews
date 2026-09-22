import Image from "next/image";

type Variant = "story" | "round" | "hero" | "thumb";

const PRESETS: Record<
  Variant,
  { width: number; height: number; sizes: string; className: string; quality: number }
> = {
  story: {
    width: 640,
    height: 640,
    sizes: "(max-width: 720px) 92vw, 380px",
    className: "cover",
    quality: 72,
  },
  round: {
    width: 320,
    height: 320,
    sizes: "160px",
    className: "cover round",
    quality: 70,
  },
  hero: {
    width: 960,
    height: 960,
    sizes: "(max-width: 900px) 94vw, 720px",
    className: "cover",
    quality: 78,
  },
  thumb: {
    width: 144,
    height: 144,
    sizes: "72px",
    className: "more-news-thumb",
    quality: 60,
  },
};

export function CoverImage({
  src,
  alt = "",
  variant = "story",
  priority = false,
}: {
  src: string;
  alt?: string;
  variant?: Variant;
  priority?: boolean;
}) {
  const preset = PRESETS[variant];
  return (
    <Image
      src={src}
      alt={alt}
      width={preset.width}
      height={preset.height}
      sizes={preset.sizes}
      className={preset.className}
      quality={preset.quality}
      priority={priority}
      loading={priority ? undefined : "lazy"}
    />
  );
}
