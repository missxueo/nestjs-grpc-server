import {
  isObject,
  isString,
  isUndefined,
} from '@nestjs/common/utils/shared.utils';
import {
  EMPTY,
  Observable,
  Subject,
  Subscription,
  defaultIfEmpty,
  fromEvent,
  lastValueFrom,
} from 'rxjs';
import { catchError, takeUntil } from 'rxjs/operators';
import { CANCEL_EVENT, GRPC_DEFAULT_URL, GRPC_DEFAULT_PROTO_LOADER, } from "@nestjs/microservices/constants"
import { CustomTransportStrategy, GrpcMethodStreamingType, GrpcOptions, MessageHandler, Server, Transport } from '@nestjs/microservices';
import type grpc from "@grpc/grpc-js"
import { InvalidProtoDefinitionException } from "@nestjs/microservices/errors/invalid-proto-definition.exception"
import { InvalidGrpcPackageException } from "@nestjs/microservices/errors/invalid-grpc-package.exception"

let grpcPackage: any = {};
let grpcProtoLoaderPackage: any = {};

interface GrpcCall<TRequest = any, TMetadata = any> {
  request: TRequest;
  metadata: TMetadata;
  sendMetadata: Function;
  end: Function;
  write: Function;
  on: Function;
  off: Function;
  emit: Function;
}

type ServiceDefinition = {name: string, service: grpc.ServiceDefinition, }

export type NestGrpcOptions = GrpcOptions["options"] & {
  serviceDefinitions: ServiceDefinition | ServiceDefinition[],
} 

export class NestServerGrpc extends Server implements CustomTransportStrategy {
  public readonly transportId = Transport.GRPC;

  private readonly url: string;
  private grpcClient: grpc.Server;

  constructor(private readonly options: NestGrpcOptions) {
    super();
    this.url = this.getOptionsProp(options, 'url') || GRPC_DEFAULT_URL;

    const protoLoader = this.getOptionsProp(options, 'protoLoader') || GRPC_DEFAULT_PROTO_LOADER;

    grpcPackage = this.loadPackage('@grpc/grpc-js', NestServerGrpc.name, () =>
      require('@grpc/grpc-js'),
    );
    grpcProtoLoaderPackage = this.loadPackage(
      protoLoader,
      NestServerGrpc.name,
      () =>
        protoLoader === GRPC_DEFAULT_PROTO_LOADER
          ? require('@grpc/proto-loader')
          : require(protoLoader),
    );
  }

  public async listen(
    callback: (err?: unknown, ...optionalParams: unknown[]) => void,
  ) {
    try {
      this.grpcClient = await this.createClient();
      await this.start(callback);
    } catch (err) {
      callback(err);
    }
  }

  public async start(callback?: () => void) {
    await this.bindEvents();
    this.grpcClient.start();
    callback?.();
  }

  public async bindEvents() {
    const grpcContext = this.loadProto();
    const packageOption = this.getOptionsProp(this.options, 'package') || [];
    const packageNames = Array.isArray(packageOption)
      ? packageOption
      : [packageOption];
    for (const packageName of packageNames) {
      const grpcPkg = this.lookupPackage(grpcContext, packageName);
      await this.createServices(grpcPkg, packageName);
    }
    const serviceDefinitionsOptions = this.getOptionsProp(this.options, "serviceDefinitions") || [];
    const serviceDefinitions = Array.isArray(serviceDefinitionsOptions)
      ? serviceDefinitionsOptions
      : [serviceDefinitionsOptions];
    for (const serviceDefinition of serviceDefinitions) {
      const svr = await this.createService(serviceDefinition.service, serviceDefinition.name);
      this.grpcClient.addService(serviceDefinition.service, svr);
    }
  }

  /**
   * Will return all of the services along with their fully namespaced
   * names as an array of objects.
   * This method initiates recursive scan of grpcPkg object
   */
  public getServiceNames(grpcPkg: any): { name: string; service: any }[] {
    // Define accumulator to collect all of the services available to load
    const services: { name: string; service: any }[] = [];
    // Initiate recursive services collector starting with empty name
    this.collectDeepServices('', grpcPkg, services);
    return services;
  }

  /**
   * Will create service mapping from gRPC generated Object to handlers
   * defined with @GrpcMethod or @GrpcStreamMethod annotations
   *
   * @param grpcService
   * @param name
   */
  public async createService(grpcService: grpc.ServiceDefinition, name: string) {
    const service = {};

    for (const methodName in grpcService) {
      let pattern = '';
      let methodHandler = null;
      let streamingType = GrpcMethodStreamingType.NO_STREAMING;

      const methodFunction = grpcService[methodName];
      const methodReqStreaming = methodFunction.requestStream;

      if (!isUndefined(methodReqStreaming) && methodReqStreaming) {
        // Try first pattern to be presented, RX streaming pattern would be
        // a preferable pattern to select among a few defined
        pattern = this.createPattern(
          name,
          methodName,
          GrpcMethodStreamingType.RX_STREAMING,
        );
        methodHandler = this.messageHandlers.get(pattern);
        streamingType = GrpcMethodStreamingType.RX_STREAMING;
        // If first pattern didn't match to any of handlers then try
        // pass-through handler to be presented
        if (!methodHandler) {
          pattern = this.createPattern(
            name,
            methodName,
            GrpcMethodStreamingType.PT_STREAMING,
          );
          methodHandler = this.messageHandlers.get(pattern);
          streamingType = GrpcMethodStreamingType.PT_STREAMING;
        }
      } else {
        pattern = this.createPattern(
          name,
          methodName,
          GrpcMethodStreamingType.NO_STREAMING,
        );
        // Select handler if any presented for No-Streaming pattern
        methodHandler = this.messageHandlers.get(pattern);
        streamingType = GrpcMethodStreamingType.NO_STREAMING;
      }
      if(!methodHandler && methodName !== methodFunction.originalName){
        pattern = this.createPattern(name, methodFunction.originalName, streamingType);
        methodHandler = this.messageHandlers.get(pattern);
      }
      if (!methodHandler) {
        continue;
      }
      service[methodName] = await this.createServiceMethod(
        methodHandler,
        grpcService[methodName],
        streamingType,
      );
    }
    return service;
  }

  /**
   * Will create a string of a JSON serialized format
   *
   * @param service name of the service which should be a match to gRPC service definition name
   * @param methodName name of the method which is coming after rpc keyword
   * @param streaming GrpcMethodStreamingType parameter which should correspond to
   * stream keyword in gRPC service request part
   */
  public createPattern(
    service: string,
    methodName: string,
    streaming: GrpcMethodStreamingType,
  ): string {
    return JSON.stringify({
      service,
      rpc: methodName,
      streaming,
    });
  }

  /**
   * Will return async function which will handle gRPC call
   * with Rx streams or as a direct call passthrough
   *
   * @param methodHandler
   * @param protoNativeHandler
   */
  public createServiceMethod(
    methodHandler: Function,
    protoNativeHandler: any,
    streamType: GrpcMethodStreamingType,
  ): Function {
    // If proto handler has request stream as "true" then we expect it to have
    // streaming from the side of requester
    if (protoNativeHandler.requestStream) {
      // If any handlers were defined with GrpcStreamMethod annotation use RX
      if (streamType === GrpcMethodStreamingType.RX_STREAMING) {
        return this.createRequestStreamMethod(
          methodHandler,
          protoNativeHandler.responseStream,
        );
      }
      // If any handlers were defined with GrpcStreamCall annotation
      else if (streamType === GrpcMethodStreamingType.PT_STREAMING) {
        return this.createStreamCallMethod(
          methodHandler,
          protoNativeHandler.responseStream,
        );
      }
    }
    return protoNativeHandler.responseStream
      ? this.createStreamServiceMethod(methodHandler)
      : this.createUnaryServiceMethod(methodHandler);
  }

  public createUnaryServiceMethod(methodHandler: Function): Function {
    return async (call: GrpcCall, callback: Function) => {
      const handler = methodHandler(call.request, call.metadata, call);
      this.transformToObservable(await handler).subscribe({
        next: async data => callback(null, await data),
        error: (err: any) => callback(err),
      });
    };
  }

  public createStreamServiceMethod(methodHandler: Function): Function {
    return async (call: GrpcCall, callback: Function) => {
      const handler = methodHandler(call.request, call.metadata, call);
      const result$ = this.transformToObservable(await handler);

      try {
        await this.writeObservableToGrpc(result$, call);
      } catch (err) {
        call.emit('error', err);
        return;
      }
    };
  }

  /**
   * Writes an observable to a GRPC call.
   *
   * This function will ensure that backpressure is managed while writing values
   * that come from an observable to a GRPC call.
   *
   * @param source The observable we want to write out to the GRPC call.
   * @param call The GRPC call we want to write to.
   * @returns A promise that resolves when we're done writing to the call.
   */
  public writeObservableToGrpc<T>(
    source: Observable<T>,
    call: GrpcCall<T>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // This buffer is used to house values that arrive
      // while the call is in the process of writing and draining.
      const buffer: T[] = [];
      let isComplete = false;
      let clearToWrite = true;

      const cleanups: (() => void)[] = [];
      const cleanup = () => {
        for (const cleanup of cleanups) {
          cleanup();
        }
      };

      const write = (value: T) => {
        // If the stream `write` returns `false`, we have
        // to wait for a drain event before writing again.
        // This is done to handle backpressure.
        clearToWrite = call.write(value);
      };

      const done = () => {
        call.end();
        resolve();
        cleanup();
      };

      // Handling backpressure by waiting for drain event
      const drainHandler = () => {
        if (!clearToWrite) {
          clearToWrite = true;
          if (buffer.length > 0) {
            // Write any queued values we have in our buffer.
            write(buffer.shift()!);
          } else if (isComplete) {
            // Otherwise, if we're complete, end the call.
            done();
          }
        }
      };

      call.on('drain', drainHandler);
      cleanups.push(() => {
        call.off('drain', drainHandler);
      });

      const subscription = new Subscription();

      // Make sure that a cancel event unsubscribes from
      // the source observable.
      const cancelHandler = () => {
        subscription.unsubscribe();
        done();
      };

      call.on(CANCEL_EVENT, cancelHandler);
      cleanups.push(() => {
        call.off(CANCEL_EVENT, cancelHandler);
      });

      subscription.add(
        source.subscribe({
          next: (value: T) => {
            if (clearToWrite) {
              // If we're not currently writing, then
              // we can write the value immediately.
              write(value);
            } else {
              // If a value arrives while we're writing
              // then we queue it up to be processed FIFO.
              buffer.push(value);
            }
          },
          error: (err: any) => {
            call.emit('error', err);
            reject(err);
            cleanup();
          },
          complete: () => {
            isComplete = true;
            if (buffer.length === 0) {
              done();
            }
          },
        }),
      );
    });
  }

  public createRequestStreamMethod(
    methodHandler: Function,
    isResponseStream: boolean,
  ) {
    return async (
      call: GrpcCall,
      callback: (err: unknown, value: unknown) => void,
    ) => {
      const req = new Subject<any>();
      call.on('data', (m: any) => req.next(m));
      call.on('error', (e: any) => {
        // Check if error means that stream ended on other end
        const isCancelledError = String(e).toLowerCase().indexOf('cancelled');

        if (isCancelledError) {
          call.end();
          return;
        }
        // If another error then just pass it along
        req.error(e);
      });
      call.on('end', () => req.complete());

      const handler = methodHandler(req.asObservable(), call.metadata, call);
      const res = this.transformToObservable(await handler);
      if (isResponseStream) {
        await this.writeObservableToGrpc(res, call);
      } else {
        const response = await lastValueFrom(
          res.pipe(
            takeUntil(fromEvent(call as any, CANCEL_EVENT)),
            catchError(err => {
              callback(err, null);
              return EMPTY;
            }),
            defaultIfEmpty(undefined),
          ),
        );

        if (!isUndefined(response)) {
          callback(null, response);
        }
      }
    };
  }

  public createStreamCallMethod(
    methodHandler: Function,
    isResponseStream: boolean,
  ) {
    return async (
      call: GrpcCall,
      callback: (err: unknown, value: unknown) => void,
    ) => {
      if (isResponseStream) {
        methodHandler(call);
      } else {
        methodHandler(call, callback);
      }
    };
  }

  public async close(): Promise<void> {
    if (this.grpcClient) {
      const graceful = this.getOptionsProp(this.options, 'gracefulShutdown');
      if (graceful) {
        await new Promise<void>((resolve, reject) => {
          this.grpcClient.tryShutdown((error: Error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      } else {
        this.grpcClient.forceShutdown();
      }
    }
    this.grpcClient = null;
  }

  public deserialize(obj: any): any {
    try {
      return JSON.parse(obj);
    } catch (e) {
      return obj;
    }
  }

  public addHandler(
    pattern: unknown,
    callback: MessageHandler,
    isEventHandler = false,
  ) {
    const route = isString(pattern) ? pattern : JSON.stringify(pattern);
    callback.isEventHandler = isEventHandler;
    this.messageHandlers.set(route, callback);
  }

  public async createClient(): Promise<any> {
    const channelOptions: grpc.ChannelOptions =
      this.options && this.options.channelOptions
        ? this.options.channelOptions
        : {};
    if (this.options && this.options.maxSendMessageLength) {
      channelOptions['grpc.max_send_message_length'] =
        this.options.maxSendMessageLength;
    }
    if (this.options && this.options.maxReceiveMessageLength) {
      channelOptions['grpc.max_receive_message_length'] =
        this.options.maxReceiveMessageLength;
    }
    if (this.options && this.options.maxMetadataSize) {
      channelOptions['grpc.max_metadata_size'] = this.options.maxMetadataSize;
    }
    const server = new grpcPackage.Server(channelOptions);
    const credentials = this.getOptionsProp(this.options, 'credentials');

    await new Promise((resolve, reject) => {
      server.bindAsync(
        this.url,
        credentials || grpcPackage.ServerCredentials.createInsecure(),
        (error: Error | null, port: number) =>
          error ? reject(error) : resolve(port),
      );
    });

    return server;
  }

  public lookupPackage(root: any, packageName: string) {
    /** Reference: https://github.com/kondi/rxjs-grpc */
    let pkg = root;
    for (const name of packageName.split(/\./)) {
      pkg = pkg[name];
    }
    return pkg;
  }

  public loadProto(): any {
    try {
      const file = this.getOptionsProp(this.options, 'protoPath') || [];
      const loader = this.getOptionsProp(this.options, 'loader');

      const packageDefinition = grpcProtoLoaderPackage.loadSync(file, loader);
      const packageObject = grpcPackage.loadPackageDefinition(packageDefinition);
      return packageObject;
    } catch (err) {
      const invalidProtoError = new InvalidProtoDefinitionException(err.path);
      const message =
        err && err.message ? err.message : invalidProtoError.message;

      this.logger.error(message, invalidProtoError.stack);
      throw err;
    }
  }

  /**
   * Recursively fetch all of the service methods available on loaded
   * protobuf descriptor object, and collect those as an objects with
   * dot-syntax full-path names.
   *
   * Example:
   *  for proto package Bundle.FirstService with service Events { rpc...
   *  will be resolved to object of (while loaded for Bundle package):
   *    {
   *      name: "FirstService.Events",
   *      service: {Object}
   *    }
   */
  private collectDeepServices(
    name: string,
    grpcDefinition: any,
    accumulator: { name: string; service: any }[],
  ) {
    if (!isObject(grpcDefinition)) {
      return;
    }
    const keysToTraverse = Object.keys(grpcDefinition);
    // Traverse definitions or namespace extensions
    for (const key of keysToTraverse) {
      const nameExtended = this.parseDeepServiceName(name, key);
      const deepDefinition = grpcDefinition[key];

      const isServiceDefined =
        deepDefinition && !isUndefined(deepDefinition.service);
      const isServiceBoolean = isServiceDefined
        ? deepDefinition.service !== false
        : false;

      if (isServiceDefined && isServiceBoolean) {
        accumulator.push({
          name: nameExtended,
          service: deepDefinition,
        });
      }
      // Continue recursion until objects end or service definition found
      else {
        this.collectDeepServices(nameExtended, deepDefinition, accumulator);
      }
    }
  }

  private parseDeepServiceName(name: string, key: string): string {
    // If depth is zero then just return key
    if (name.length === 0) {
      return key;
    }
    // Otherwise add next through dot syntax
    return name + '.' + key;
  }

  private async createServices(grpcPkg: any, packageName: string) {
    if (!grpcPkg) {
      const invalidPackageError = new InvalidGrpcPackageException(packageName);
      this.logger.error(invalidPackageError.message, invalidPackageError.stack);
      throw invalidPackageError;
    }

    // Take all of the services defined in grpcPkg and assign them to
    // method handlers defined in Controllers
    for (const definition of this.getServiceNames(grpcPkg)) {
      const svr = await this.createService(definition.service.service, definition.name);
      this.grpcClient.addService(
        // First parameter requires exact service definition from proto
        definition.service.service,
        // Here full proto definition required along with namespaced pattern name
        svr,
      );
    }
  }
}
