import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestServerGrpc } from "nestjs-grpc-server"
import { MicroserviceOptions } from "@nestjs/microservices"
import { greetServiceDefinition } from "./protos/greet.grpc-server"

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.connectMicroservice<MicroserviceOptions>({
    strategy: new NestServerGrpc({
      protoPath: [],
      package: [],
      serviceDefinitions: [
        {
          name: "GreetService",
          service: greetServiceDefinition,
        }
      ]
    })
  });

  await app.startAllMicroservices();

  await app.listen(3000);
}
bootstrap();
