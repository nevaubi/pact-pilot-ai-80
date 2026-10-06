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
          "Matters, deadlines, closings and house-template drafting with on-request AI support.",
      },
      { property: "og:title", content: "Mirza" },
      {
        property: "og:description",
        content: "Matter management for boutique transactional law firms.",
      },
    ],
  }),
});
