import type { ErrorComponentProps } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { Toaster } from "sonner";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-base px-4">
      <div className="max-w-md text-center">
        <p className="font-mono text-xs uppercase tracking-widest text-brand-primary">
          Error 404
        </p>
        <h1 className="mt-3 font-mono text-6xl font-bold text-foreground">
          NO_ROUTE
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          The dispatch channel you requested doesn't exist.
        </p>
        <Link
          to="/"
          className="mt-6 inline-flex items-center justify-center rounded-md bg-brand-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:brightness-110"
        >
          Return to base
        </Link>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: ErrorComponentProps) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-base px-4">
      <div className="max-w-md text-center">
        <p className="font-mono text-xs uppercase tracking-widest text-destructive">
          System fault
        </p>
        <h1 className="mt-3 text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-brand-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:brightness-110"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-surface-border bg-surface-elevated px-4 py-2 text-sm font-medium text-foreground transition hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Medical Calling AI - AI-Powered Outbound Calling at Scale" },
      {
        name: "description",
        content:
          "Launch AI-powered outbound calling campaigns at scale. Twilio telephony, ElevenLabs voices, GPT-powered conversations.",
      },
      { name: "author", content: "Medical Calling AI" },
      { property: "og:title", content: "Medical Calling AI - AI-Powered Outbound Calling at Scale" },
      {
        property: "og:description",
        content: "AI-powered outbound calling campaigns at scale.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: "Medical Calling AI - AI-Powered Outbound Calling at Scale" },
      { name: "description", content: "Launch AI-powered outbound calling campaigns at scale. Twilio telephony, ElevenLabs voices, GPT-powered conversations." },
      { property: "og:description", content: "Launch AI-powered outbound calling campaigns at scale. Twilio telephony, ElevenLabs voices, GPT-powered conversations." },
      { name: "twitter:description", content: "Launch AI-powered outbound calling campaigns at scale. Twilio telephony, ElevenLabs voices, GPT-powered conversations." },
      { property: "og:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/29603eca-f598-418b-8a01-8b8217f7aafc/id-preview-627fa8ee--c2d455c6-ca10-450b-8639-635c2ce68556.lovable.app-1783404507525.png" },
      { name: "twitter:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/29603eca-f598-418b-8a01-8b8217f7aafc/id-preview-627fa8ee--c2d455c6-ca10-450b-8639-635c2ce68556.lovable.app-1783404507525.png" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      {
        rel: "icon",
        type: "image/png",
        href: "/logo.png",
      },
      {
        rel: "apple-touch-icon",
        href: "/logo.png",
      },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossOrigin: "anonymous",
      },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body className="bg-surface-base text-foreground">
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
      <Toaster theme="dark" position="top-right" richColors closeButton />
    </QueryClientProvider>
  );
}
