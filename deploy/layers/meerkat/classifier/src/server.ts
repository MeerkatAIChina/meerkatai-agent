import Fastify from "fastify";

const app = Fastify({ logger: true });

app.post("/classify", async (_request, reply) => {
  return reply.status(501).send({ error: "not implemented" });
});

const port = Number(process.env.PORT ?? 8080);

app
  .listen({ port, host: "0.0.0.0" })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
