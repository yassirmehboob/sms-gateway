import { z } from 'zod';

export function cmsPublicOrigin(value?: string) {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('CMS_PUBLIC_ORIGIN must be an HTTPS origin without a path, credentials, query or fragment');
  }
  return url.origin;
}

export function applicationBasePath(value = '') {
  const path = value.replace(/\/$/, '');
  return z.string().regex(/^(?:\/[A-Za-z0-9_-]+)*$/).parse(path);
}

// Some Passenger installations strip the mount path; others forward it intact.
export function applicationUrls(url: string, basePath: string) {
  const mounted = basePath && (url === basePath || url.startsWith(`${basePath}/`) || url.startsWith(`${basePath}?`));
  const stripped = mounted ? url.slice(basePath.length) : url;
  const internal = !stripped || stripped.startsWith('?') ? `/${stripped}` : stripped;
  return { internal, external: basePath + internal };
}

export function deploymentConfig(env: NodeJS.ProcessEnv, passengerDetected = false) {
  const mode = z.enum(['local', 'passenger']).parse(env.DEPLOYMENT_MODE ?? (passengerDetected ? 'passenger' : 'local'));
  const proxyHops = z.coerce.number().int().min(0).max(10).parse(env.TRUST_PROXY_HOPS ?? 0);
  return { passenger: mode === 'passenger', proxyHops, basePath: applicationBasePath(env.APP_BASE_PATH), cmsOrigin: cmsPublicOrigin(env.CMS_PUBLIC_ORIGIN) };
}

export function needsCmsListener(passenger: boolean, host: string, port: number, cmsPort: number) {
  return !passenger && (cmsPort !== port || host !== '127.0.0.1');
}
