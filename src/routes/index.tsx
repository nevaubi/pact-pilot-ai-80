import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/today" });
  },
  head: () => ({
    meta: [
      { title: "Mirza — Matter management for boutique law firms" },
      {
        name: "description",
        content:
          "Manage matters, deadlines, documents and closings in one workspace, with house-template drafting and attorney-reviewed AI support for boutique law firms.",
      },
      { property: "og:title", content: "Mirza — Matter management for boutique law firms" },
      {
        property: "og:description",
        content: "Manage matters, deadlines, documents and closings in one workspace, with house-template drafting and attorney-reviewed AI support for boutique law firms.",
      },
      { property: "og:type", content: "website" },
      { property: "og:image", content: "https://pact-pilot-ai-80.lovable.app/mirza-social.jpg" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:alt", content: "Mirza — Matter management for boutique law firms. Matters. Deadlines. Closings." },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: "https://pact-pilot-ai-80.lovable.app/mirza-social.jpg" },
    ],
  }),
});
