
compatible options of Nestjs ServerGrpc

support add service generate by `protobuf-ts`

`NestServerGrpc` transport use `Transport.Grpc`

```ts
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
```

```ts
  @GrpcMethod("GreetService", "Hello")
  async hello(req: GreetRequest, metadata: any): Promise<GreetResponse>{

    return {
      from: "bill",
      reply: `hello ${req.to}`
    }
  }

```


```proto3
syntax = "proto3";

package greet.v1;

service GreetService {
  rpc Hello(GreetRequest) returns (GreetResponse) {}
}

message GreetRequest {
  string to = 1;
  string content = 2;
}

message GreetResponse {
  string from = 1;
  string reply = 2;
}
```