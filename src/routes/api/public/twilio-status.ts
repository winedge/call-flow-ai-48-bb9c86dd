import { createFileRoute } from '@tanstack/react-router';
import { cred } from "@/lib/config/credentials";

export const Route = createFileRoute('/api/public/twilio-status')({
  server: {
    handlers: {
      GET: async () => {
        const sid = (await cred("TWILIO_ACCOUNT_SID"));
        const token = (await cred("TWILIO_AUTH_TOKEN"));

        return new Response(
          JSON.stringify({
            live: !!(sid && token),
            timestamp: Date.now(),
          }),
          {
            headers: {
              'Content-Type': 'application/json',
            },
          }
        );
      },
    },
  },
});
