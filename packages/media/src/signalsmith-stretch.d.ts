// The Signalsmith Stretch package ships no declarations. The adapter checks
// the node it creates before use, so the factory returns `unknown`.
declare module "signalsmith-stretch" {
  const SignalsmithStretch: (context: object, options?: object) => Promise<unknown>;
  export default SignalsmithStretch;
}
