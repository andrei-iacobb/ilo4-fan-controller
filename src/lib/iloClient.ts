import { execFile } from "child_process";
import { changeFanSpeedSchema, ChangeFanSpeedInput } from "../schemas/changeFanSpeed";
import type { FanObject } from "../types/Fan";

const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://prometheus-kube-prometheus-prometheus.monitoring:9090";

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

type PromResult = {
    metric: { name: string; host: string };
    value: [number, string];
};

export const fetchFans = async (): Promise<FanObject[]> => {
    ensureEnv();
    const host = getIloHost();

    // Query Prometheus for fan data (iLO4's HTTPS/TLS is too old for any modern client)
    const query = `last_over_time(ilo_chassis_fan_current_percent{host="${host}"}[24h])`;
    const response = await fetch(
        `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`
    );

    if (!response.ok) {
        throw new Error(`Prometheus query failed (${response.status})`);
    }

    const data = (await response.json()) as { data: { result: PromResult[] } };
    const results = data.data.result;

    if (results.length === 0) {
        throw new Error("No fan data available from Prometheus");
    }

    return results
        .sort((a, b) => a.metric.name.localeCompare(b.metric.name))
        .map((r) => ({
            CurrentReading: parseInt(r.value[1], 10),
            FanName: r.metric.name,
            Status: { Health: "OK", State: "Enabled" },
            Units: "Percent",
            Oem: {
                Hp: {
                    "@odata.type": "#HpServerFan.1.0.0.HpServerFan",
                    Location: "System",
                    Type: "HpServerFan.1.0.0",
                },
            },
        }));
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
