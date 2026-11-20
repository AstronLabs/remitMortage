"use client";

import Image from "next/image";
import { useState } from "react";

const gateway = "https://ipfs.io/ipfs/";
const primaryGateway = "https://cloudflare-ipfs.com/ipfs/";

export default function EvidenceThumbnail({ cid, label }: { cid: string; label: string }) {
  const [source, setSource] = useState(primaryGateway);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const path = cid.split("/").map(encodeURIComponent).join("/");

  return (
    <a href={gateway + path} target="_blank" rel="noopener noreferrer" aria-label={`Open full-size ${label}`}
      className="relative block aspect-[4/3] max-w-full overflow-hidden rounded-lg bg-slate-900 focus-visible:outline">
      {!loaded && !failed && (
        <span data-testid="evidence-thumbnail-placeholder" aria-hidden="true"
          className="absolute inset-0 scale-110 bg-gradient-to-br from-slate-600 via-slate-800 to-slate-950 blur-md" />
      )}
      {failed ? (
        <span className="absolute inset-0 grid place-content-center p-3 text-center text-sm">Preview unavailable. Open original.</span>
      ) : (
        <Image src={source + path} alt={label} fill sizes="(max-width: 640px) 80vw, 384px" loading="lazy"
          className={`object-contain ${loaded ? "opacity-100" : "opacity-0"}`}
          onLoad={() => setLoaded(true)}
          onError={() => {
            if (source === primaryGateway) {
              setLoaded(false);
              setSource(gateway);
            } else setFailed(true);
          }} />
      )}
    </a>
  );
}
