import { execFile } from "child_process";
import { changeFanSpeedSchema, ChangeFanSpeedInput } from "../schemas/changeFanSpeed";
import type { FanObject } from "../types/Fan";

const getIloHost = (): string =>
    (process.env.ILO_HOST ?? "").replace(/^https?:\/\//, "");

const ensureEnv = () => {
    const missing = [
        { key: "ILO_HOST", value: process.env.ILO_HOST },
        { key: "ILO_USERNAME", value: process.env.ILO_USERNAME },
        { key: "ILO_PASSWORD", value: process.env.ILO_PASSWORD },
    ]
        .filter((entry) => !entry.value)
        .map((entry) => entry.key);

    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
    }
};

type IloThermalPayload = {
    Fans?: FanObject[];
};

export const fetchFans = async (): Promise<FanObject[]> => {
    ensureEnv();
    const host = getIloHost();
    const user = process.env.ILO_USERNAME!;
    const pass = process.env.ILO_PASSWORD!;

    // Use curl because iLO4's TLS is too old for Node.js/OpenSSL 3.x
    const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
            "curl",
            [
                "-s", "-k",
                "-u", `${user}:${pass}`,
                `https://${host}/redfish/v1/chassis/1/Thermal`,
            ],
            { timeout: 15000 },
            (error, stdout, stderr) => {
                if (error && !stdout) {
                    reject(new Error(`Redfish fetch failed: ${stderr || error.message}`));
                    return;
                }
                resolve(stdout);
            }
        );
    });

    const payload = JSON.parse(stdout) as IloThermalPayload;
    return payload.Fans ?? [];
};

const sshExec = (command: string, timeout = 15000): Promise<string> => {
    ensureEnv();
    const host = getIloHost();
    const user = process.env.ILO_USERNAME!;
    const pass = process.env.ILO_PASSWORD!;

    return new Promise((resolve, reject) => {
        execFile(
            "sshpass",
            [
                "-p", pass,
                "ssh",
                "-T",
                "-o", "KexAlgorithms=diffie-hellman-group14-sha1",
                "-o", "HostKeyAlgorithms=ssh-rsa",
                "-o", "Ciphers=aes128-cbc",
                "-o", "StrictHostKeyChecking=no",
                "-o", "ConnectTimeout=10",
                "-o", "PubkeyAuthentication=no",
                `${user}@${host}`,
                command,
            ],
            { timeout },
            (error, stdout, stderr) => {
                // iLO's SSH server returns non-zero exit codes even on success,
                // so only treat connection/timeout errors as failures
                if (error && !stdout && stderr && !stderr.includes("Warning:")) {
                    reject(new Error(`SSH command failed: ${stderr || error.message}`));
                    return;
                }
                resolve(stdout);
            }
        );
    });
};

export const unlockFans = async (): Promise<void> => {
    await sshExec("fan p global unlock");
};

export const setFanSpeeds = async (payload: ChangeFanSpeedInput): Promise<void> => {
    const validated = await changeFanSpeedSchema.validate(payload, {
        abortEarly: false,
        stripUnknown: true,
    });

    // Send all fan commands in a single SSH session to avoid
    // multiple slow connections to iLO's mpSSH server
    const commands = validated.fans
        .map((pct, i) => {
            const speed = Math.round((pct / 100) * 255);
            return `fan p ${i} lock ${speed}`;
        })
        .join("\n");
    await sshExec(commands, 30000);
};
